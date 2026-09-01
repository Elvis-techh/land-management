import { randomUUID } from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { Db } from "../db/client.js";
import { contracts, customers, lots, payments, projects } from "../db/schema.js";
import { splitEvenly } from "../lib/allocation.js";
import { recordAudit } from "../lib/audit.js";
import type { ContractTerms, SaleType } from "../lib/contracts.js";
import { assessContract, buildSchedule, financedCents, firstDueDate } from "../lib/contracts.js";
import { roleCan } from "../lib/capabilities.js";
import { businessToday } from "../lib/time.js";

/**
 * What this plugin needs from the configuration.
 *
 * The timezone is passed in rather than read from the environment here, for the
 * same reason `receiptRoutes` is handed its uploads path: a route that reaches
 * for `process.env` is a route no test can put anywhere else, and "what day is
 * it" is precisely the thing these tests need to control.
 */
interface ContractRoutesOptions {
  /** IANA name — see `timeZone` in src/config/env.ts. */
  timeZone: string;
}

/**
 * The contracts list, with every derived figure computed on read.
 *
 * The row carries the agreed TERMS. What is financed, what has been paid, what
 * is still owed and whether the customer is behind are all worked out here and
 * in src/lib/contracts.ts, every time. None of them is a column, so none of
 * them can be stale — which is the whole reason this app exists rather than a
 * spreadsheet with a `balance` field somebody has to remember to update.
 */
const contractsListQuery = (db: Db) =>
  db
    .select({
      id: contracts.id,
      code: contracts.code,
      saleGroupId: contracts.saleGroupId,
      kind: contracts.kind,
      saleType: contracts.saleType,
      status: contracts.status,
      salePriceCents: contracts.salePriceCents,
      downPaymentCents: contracts.downPaymentCents,
      termMonths: contracts.termMonths,
      monthlyPaymentCents: contracts.monthlyPaymentCents,
      dueDay: contracts.dueDay,
      signedOn: contracts.signedOn,
      firstDueOn: contracts.firstDueOn,
      expiresOn: contracts.expiresOn,
      closedAt: contracts.closedAt,
      closedReason: contracts.closedReason,
      notes: contracts.notes,
      createdAt: contracts.createdAt,
      lotId: lots.id,
      lotCode: lots.code,
      lotAreaM2: lots.areaM2,
      projectName: projects.name,
      customerId: customers.id,
      customerName: customers.fullName,
      customerPhone: customers.phone,
      paidToDateCents: sql<number>`
        COALESCE((
          SELECT SUM(${payments.amountCents})
          FROM ${payments}
          WHERE ${payments.contractId} = ${contracts.id}
            AND ${payments.reversedAt} IS NULL
        ), 0)
      `,
      // Asked separately from paid-to-date on purpose. The prima that was
      // AGREED is a term of the contract; whether it ever arrived is a fact
      // about the payments, and a screen showing only one of the two cannot
      // tell you about a customer who signed and then never came back.
      downPaymentPaidCents: sql<number>`
        COALESCE((
          SELECT SUM(${payments.amountCents})
          FROM ${payments}
          WHERE ${payments.contractId} = ${contracts.id}
            AND ${payments.reversedAt} IS NULL
            AND ${payments.type} = 'down_payment'
        ), 0)
      `,
    })
    .from(contracts)
    .innerJoin(lots, eq(lots.id, contracts.lotId))
    .innerJoin(projects, eq(projects.id, lots.projectId))
    .innerJoin(customers, eq(customers.id, contracts.customerId));

type ContractRow = ReturnType<ReturnType<typeof contractsListQuery>["all"]>[number];

/**
 * A contract as the API reports it: what was signed, plus what follows from it.
 *
 * `signedOn` falls back to the day the row was created. Contracts written
 * before the signing date existed as a column were backfilled that way by
 * migration 0004, and this keeps the fallback in one place rather than letting
 * a null reach the arithmetic.
 */
function present(row: ContractRow, asOf: string) {
  const terms: ContractTerms = {
    saleType: row.saleType as SaleType,
    salePriceCents: row.salePriceCents,
    downPaymentCents: row.downPaymentCents,
    termMonths: row.termMonths,
    monthlyPaymentCents: row.monthlyPaymentCents,
    dueDay: row.dueDay,
    signedOn: row.signedOn ?? row.createdAt.slice(0, 10),
    firstDueOn: row.firstDueOn,
  };

  const health = assessContract(terms, row.paidToDateCents, asOf);

  return {
    id: row.id,
    code: row.code,
    saleGroupId: row.saleGroupId,
    kind: row.kind,
    saleType: row.saleType,
    status: row.status,
    lot: {
      id: row.lotId,
      code: row.lotCode,
      projectName: row.projectName,
      areaM2: row.lotAreaM2,
    },
    customer: {
      id: row.customerId,
      fullName: row.customerName,
      phone: row.customerPhone,
    },
    terms: {
      salePrice: row.salePriceCents,
      downPayment: row.downPaymentCents,
      /** Derived: the part being paid in installments. Never a stored column. */
      financed: financedCents(terms),
      termMonths: row.termMonths,
      monthlyPayment: row.monthlyPaymentCents,
      dueDay: row.dueDay,
      signedOn: terms.signedOn,
      /** When the first installment actually falls due — derived if not agreed. */
      firstDueOn: firstDueDate(terms),
      /**
       * The stored column, `null` when the first due date simply follows from
       * the signing date.
       *
       * Sent alongside the computed one because the edit form cannot tell them
       * apart otherwise, and the difference matters: writing a derived date
       * back into the column would PIN it, so a later correction to `signedOn`
       * would silently stop moving the schedule with it.
       */
      firstDueOnAgreed: row.firstDueOn,
      expiresOn: row.expiresOn,
    },
    /** Every figure below is computed on this request. */
    downPaymentPaid: row.downPaymentPaidCents,
    paidToDate: row.paidToDateCents,
    balance: health.balanceCents,
    health: {
      status: health.status,
      arrears: health.arrearsCents,
      monthsBehind: health.monthsBehind,
      monthsAhead: health.monthsAhead,
      nextDueOn: health.nextDueOn,
      nextDueAmount: health.nextDueAmountCents,
      settled: health.settled,
    },
    installmentCount: buildSchedule(terms).length,
    closedAt: row.closedAt,
    closedReason: row.closedReason,
    notes: row.notes,
  };
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener el formato AAAA-MM-DD.")
  // Rejects "2026-02-31", which matches the pattern and is not a day.
  .refine((value) => value === new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10), {
    message: "Esa fecha no existe en el calendario.",
  });

const contractBody = z.object({
  customerId: z.string().uuid(),
  lotId: z.string().uuid(),
  kind: z.enum(["reservation", "contract"]),
  saleType: z.enum(["financed", "cash", "donation"]),
  /** Whole centavos. The client converts from lempiras before sending. */
  salePriceCents: z.number().int().nonnegative(),
  downPaymentCents: z.number().int().nonnegative(),
  termMonths: z.number().int().min(1).max(600).nullish(),
  monthlyPaymentCents: z.number().int().positive().nullish(),
  dueDay: z.number().int().min(1).max(31).nullish(),
  signedOn: isoDate,
  firstDueOn: isoDate.nullish(),
  expiresOn: isoDate.nullish(),
  notes: z.string().trim().max(2000).nullish(),
  /**
   * Join the sale group of an existing contract — the second and third lot of
   * one purchase. The group is created on the fly if that contract does not
   * have one yet.
   */
  joinGroupOfContractId: z.string().uuid().nullish(),
});

/** Editing terms keeps the same lot and customer: a different lot is a different sale. */
const updateBody = contractBody
  .omit({ customerId: true, lotId: true, joinGroupOfContractId: true })
  .extend({
    /**
     * Why the terms are being changed. Required for EVERY edit — the handler
     * rejects a missing one with its own `reason_required` code, which is why
     * this stays `.optional()` here rather than being enforced by the schema.
     */
    reason: z.string().trim().min(10).max(500).optional(),
  });

const cancelBody = z.object({
  reason: z.string().trim().min(10).max(500),
});

/**
 * The terms that do not add up, worded for the person at the screen, or `null`
 * when the contract is coherent.
 *
 * Kept apart from the Zod schema because these are relationships BETWEEN
 * fields — a term of 24 months means nothing on a cash sale, and a donation
 * with a price is not a donation. Zod validates each field; this validates the
 * agreement.
 */
function termsProblem(
  body: z.infer<typeof contractBody> | z.infer<typeof updateBody>,
): string | null {
  const hasSchedule =
    body.termMonths != null || body.monthlyPaymentCents != null || body.dueDay != null;

  if (body.saleType === "financed") {
    if (body.termMonths == null || body.monthlyPaymentCents == null || body.dueDay == null) {
      return "Un contrato a crédito necesita plazo en meses, cuota mensual y día de pago.";
    }
  } else if (hasSchedule) {
    return body.saleType === "cash"
      ? "Una venta de contado se salda al firmar: no lleva plazo, cuota ni día de pago."
      : "Una donación no lleva plazo, cuota ni día de pago.";
  }

  if (body.saleType === "donation" && (body.salePriceCents > 0 || body.downPaymentCents > 0)) {
    // Recorded at zero rather than left out of the table: the lot's history has
    // to say what became of it, and "no aparece" is not an answer.
    return "Una donación se registra con precio y prima en cero.";
  }

  if (body.downPaymentCents > body.salePriceCents) {
    return "La prima no puede ser mayor que el precio de venta.";
  }

  if (body.saleType === "financed" && body.downPaymentCents === body.salePriceCents) {
    return "Si la prima cubre todo el precio, la venta es de contado, no a crédito.";
  }

  if (body.kind === "reservation" && !body.expiresOn) {
    // A hold with no end date keeps a lot off the market forever and nobody
    // ever notices. That is the difference between a reservation and a sale.
    return "Una reserva necesita una fecha de vencimiento.";
  }

  if (body.firstDueOn && body.firstDueOn < body.signedOn) {
    return "La primera cuota no puede vencer antes de firmar el contrato.";
  }

  if (body.expiresOn && body.expiresOn < body.signedOn) {
    return "El vencimiento de la reserva no puede ser anterior a la firma.";
  }

  return null;
}

/**
 * The next contract number for a year, e.g. "CT-2026-014".
 *
 * Server-assigned and sequential. The unique index on `code` is what actually
 * guarantees no two contracts share a number; this makes the common case land
 * on the next free one instead of colliding.
 */
function nextContractCode(db: Db, year: string): string {
  const prefix = `CT-${year}-`;

  const latest = db
    .select({ code: contracts.code })
    .from(contracts)
    .where(sql`${contracts.code} LIKE ${`${prefix}%`}`)
    .orderBy(desc(contracts.code))
    .get();

  const sequence = latest ? Number(latest.code.slice(prefix.length)) : 0;

  return `${prefix}${String((Number.isFinite(sequence) ? sequence : 0) + 1).padStart(3, "0")}`;
}

export const contractRoutes: FastifyPluginAsync<ContractRoutesOptions> = async (
  app,
  options,
) => {
  /** Today in the office's calendar, not the server's and not UTC's. */
  const today = () => businessToday(options.timeZone);

  app.get("/contracts", { onRequest: app.requireUser }, async (_request, reply) => {
    const asOf = today();

    return reply.send({
      contracts: contractsListQuery(app.db)
        .orderBy(desc(contracts.code))
        .all()
        .map((row) => present(row, asOf)),
    });
  });

  /**
   * How one payment would be split across a purchase, without posting anything.
   *
   * The Contratos screen offers this on a customer holding several lots, so the
   * amounts can be seen and adjusted before any money is recorded. The rule
   * itself lives in src/lib/allocation.ts.
   */
  app.get<{ Params: { groupId: string }; Querystring: { amountCents?: string } }>(
    "/contracts/groups/:groupId/split",
    { onRequest: app.requireUser },
    async (request, reply) => {
      const amountCents = Number(request.query.amountCents);

      if (!Number.isInteger(amountCents) || amountCents <= 0) {
        return reply.code(400).send({
          error: "invalid_amount",
          message: "Indica el monto a repartir, en centavos.",
        });
      }

      const asOf = today();

      const members = contractsListQuery(app.db)
        .where(
          and(eq(contracts.saleGroupId, request.params.groupId), eq(contracts.status, "active")),
        )
        .all()
        .map((row) => present(row, asOf));

      if (members.length === 0) {
        return reply.code(404).send({
          error: "not_found",
          message: "Esa compra no tiene contratos vigentes.",
        });
      }

      const split = splitEvenly(
        amountCents,
        members.map((member) => ({
          contractId: member.id,
          code: member.code,
          balanceCents: member.balance,
        })),
      );

      return reply.send({
        amountCents,
        unallocatedCents: split.unallocatedCents,
        lines: split.allocations.map((allocation) => {
          const member = members.find((candidate) => candidate.id === allocation.contractId)!;

          return {
            contractId: member.id,
            contractCode: member.code,
            lotCode: member.lot.code,
            amountCents: allocation.amountCents,
            balanceBefore: member.balance,
            balanceAfter: member.balance - allocation.amountCents,
          };
        }),
      });
    },
  );

  app.post(
    "/contracts",
    { onRequest: app.requireCapability("contract:create") },
    async (request, reply) => {
      const parsed = contractBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Revisa los datos del contrato.",
          issues: parsed.error.issues.map((issue) => issue.message),
        });
      }

      const problem = termsProblem(parsed.data);

      if (problem) {
        return reply.code(400).send({ error: "invalid_terms", message: problem });
      }

      const actor = request.user!;

      const lot = app.db.select().from(lots).where(eq(lots.id, parsed.data.lotId)).get();

      if (!lot || lot.archivedAt !== null) {
        return reply.code(400).send({
          error: "unknown_lot",
          message: "Ese lote no existe o está archivado.",
        });
      }

      const customer = app.db
        .select()
        .from(customers)
        .where(eq(customers.id, parsed.data.customerId))
        .get();

      if (!customer) {
        return reply
          .code(400)
          .send({ error: "unknown_customer", message: "Ese cliente no existe." });
      }

      // A lot can only be held once. This is what stops the same lot being sold
      // to two people, which no amount of care in the interface can prevent on
      // its own once two staff are entering contracts at the same time.
      const holder = app.db
        .select({ code: contracts.code })
        .from(contracts)
        .where(and(eq(contracts.lotId, lot.id), eq(contracts.status, "active")))
        .get();

      if (holder) {
        return reply.code(409).send({
          error: "lot_taken",
          message: `El lote ${lot.code} ya tiene el contrato ${holder.code} vigente.`,
        });
      }

      // Joining a purchase that already exists: the second lot of the same
      // deal. Both contracts must belong to the same person, or one customer's
      // payment would be split onto another's lot.
      let saleGroupId: string | null = null;
      let groupSeed: { id: string; saleGroupId: string | null } | null = null;

      if (parsed.data.joinGroupOfContractId) {
        const sibling = app.db
          .select({
            id: contracts.id,
            saleGroupId: contracts.saleGroupId,
            customerId: contracts.customerId,
            status: contracts.status,
          })
          .from(contracts)
          .where(eq(contracts.id, parsed.data.joinGroupOfContractId))
          .get();

        if (!sibling || sibling.status !== "active") {
          return reply.code(400).send({
            error: "unknown_group",
            message: "El contrato al que quieres unir esta compra no existe o no está vigente.",
          });
        }

        if (sibling.customerId !== customer.id) {
          return reply.code(400).send({
            error: "group_customer_mismatch",
            message: "Una compra agrupa lotes de un solo cliente.",
          });
        }

        saleGroupId = sibling.saleGroupId ?? randomUUID();
        groupSeed = { id: sibling.id, saleGroupId: sibling.saleGroupId };
      }

      const now = new Date().toISOString();
      const code = nextContractCode(app.db, parsed.data.signedOn.slice(0, 4));

      const created = app.db.transaction((tx) => {
        // The first lot of a purchase was written before anybody knew a second
        // one was coming, so it has no group id. Stamping it here is what turns
        // two separate contracts into one purchase.
        if (groupSeed && groupSeed.saleGroupId === null && saleGroupId !== null) {
          tx.update(contracts)
            .set({ saleGroupId, updatedAt: now })
            .where(eq(contracts.id, groupSeed.id))
            .run();
        }

        const next = tx
          .insert(contracts)
          .values({
            id: randomUUID(),
            code,
            lotId: lot.id,
            customerId: customer.id,
            saleGroupId,
            kind: parsed.data.kind,
            saleType: parsed.data.saleType,
            status: "active",
            salePriceCents: parsed.data.salePriceCents,
            downPaymentCents: parsed.data.downPaymentCents,
            termMonths: parsed.data.termMonths ?? null,
            monthlyPaymentCents: parsed.data.monthlyPaymentCents ?? null,
            dueDay: parsed.data.dueDay ?? null,
            signedOn: parsed.data.signedOn,
            firstDueOn: parsed.data.firstDueOn ?? null,
            expiresOn: parsed.data.expiresOn ?? null,
            notes: parsed.data.notes ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "contract",
          entityId: next.id,
          action: "create",
          after: {
            code: next.code,
            lotId: next.lotId,
            customerId: next.customerId,
            saleGroupId: next.saleGroupId,
            kind: next.kind,
            saleType: next.saleType,
            salePriceCents: next.salePriceCents,
            downPaymentCents: next.downPaymentCents,
            termMonths: next.termMonths,
            monthlyPaymentCents: next.monthlyPaymentCents,
            dueDay: next.dueDay,
            signedOn: next.signedOn,
          },
        });

        return next;
      });

      return reply.code(201).send({
        contract: { id: created.id, code: created.code, saleGroupId: created.saleGroupId },
      });
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/contracts/:id",
    { onRequest: app.requireCapability("contract:edit") },
    async (request, reply) => {
      const parsed = updateBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Revisa los datos del contrato.",
          issues: parsed.error.issues.map((issue) => issue.message),
        });
      }

      const problem = termsProblem(parsed.data);

      if (problem) {
        return reply.code(400).send({ error: "invalid_terms", message: problem });
      }

      const actor = request.user!;
      const existing = app.db
        .select()
        .from(contracts)
        .where(eq(contracts.id, request.params.id))
        .get();

      if (!existing) {
        return reply.code(404).send({ error: "not_found", message: "Contrato no encontrado." });
      }

      if (existing.status !== "active") {
        // A cancelled or defaulted contract is history. Editing it would
        // rewrite what the parties are recorded as having agreed.
        return reply.code(409).send({
          error: "not_active",
          message: "Solo se editan contratos vigentes. Este ya está cerrado.",
        });
      }

      const paidToDateCents =
        app.db
          .select({ total: sql<number>`COALESCE(SUM(${payments.amountCents}), 0)` })
          .from(payments)
          .where(and(eq(payments.contractId, existing.id), sql`${payments.reversedAt} IS NULL`))
          .get()?.total ?? 0;

      // EVERY edit to signed terms demands a written motive, not only a
      // reprice. These are the figures both parties shook hands on, so a due
      // day that quietly moved from the 15th to the 5th is exactly the kind of
      // change somebody has to be able to ask about six months later — and the
      // person who moved it will not remember. `reason` stays optional in the
      // schema so this can answer with its own error code and its own wording
      // instead of a generic body rejection.
      if (!parsed.data.reason) {
        return reply.code(400).send({
          error: "reason_required",
          message:
            `Explica por qué se modifican los términos del contrato ${existing.code} ` +
            "(mínimo 10 caracteres).",
        });
      }

      // Repricing is the one edit here that moves money, so on top of the
      // motive it carries a capability of its own and is filed under its own
      // audit action. Deliberately NOT `price:change`, which is about a lot's
      // list price: changing what a lot is advertised at and changing what a
      // customer already owes are different powers, and an owner may well want
      // to hand over the first without the second.
      const isRepricing = parsed.data.salePriceCents !== existing.salePriceCents;

      if (isRepricing && !roleCan(app.db, actor.role, "contract:reprice")) {
        return reply.code(403).send({
          error: "forbidden",
          message: "Tu usuario puede editar contratos, pero no cambiar el precio de venta.",
        });
      }

      if (parsed.data.salePriceCents < paidToDateCents) {
        // Otherwise the contract would owe a negative amount, and the customer
        // would be owed a refund nothing in the app can express yet.
        return reply.code(400).send({
          error: "price_below_paid",
          message: "El precio no puede quedar por debajo de lo ya pagado en este contrato.",
        });
      }

      const now = new Date().toISOString();

      const updated = app.db.transaction((tx) => {
        const next = tx
          .update(contracts)
          .set({
            kind: parsed.data.kind,
            saleType: parsed.data.saleType,
            salePriceCents: parsed.data.salePriceCents,
            downPaymentCents: parsed.data.downPaymentCents,
            termMonths: parsed.data.termMonths ?? null,
            monthlyPaymentCents: parsed.data.monthlyPaymentCents ?? null,
            dueDay: parsed.data.dueDay ?? null,
            signedOn: parsed.data.signedOn,
            firstDueOn: parsed.data.firstDueOn ?? null,
            expiresOn: parsed.data.expiresOn ?? null,
            notes: parsed.data.notes ?? null,
            updatedAt: now,
          })
          .where(eq(contracts.id, existing.id))
          .returning()
          .get();

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "contract",
          entityId: existing.id,
          action: isRepricing ? "reprice" : "update",
          reason: parsed.data.reason ?? null,
          before: {
            kind: existing.kind,
            saleType: existing.saleType,
            salePriceCents: existing.salePriceCents,
            downPaymentCents: existing.downPaymentCents,
            termMonths: existing.termMonths,
            monthlyPaymentCents: existing.monthlyPaymentCents,
            dueDay: existing.dueDay,
            signedOn: existing.signedOn,
          },
          after: {
            kind: next.kind,
            saleType: next.saleType,
            salePriceCents: next.salePriceCents,
            downPaymentCents: next.downPaymentCents,
            termMonths: next.termMonths,
            monthlyPaymentCents: next.monthlyPaymentCents,
            dueDay: next.dueDay,
            signedOn: next.signedOn,
          },
        });

        return next;
      });

      return reply.send({ contract: { id: updated.id, code: updated.code } });
    },
  );

  /**
   * Cancel a contract and give the lot back.
   *
   * Nothing is deleted. The row stays, its payments stay, and the lot becomes
   * available again by itself — availability is derived from active contracts,
   * so releasing it is a consequence of the status change rather than a second
   * write that could fail on its own.
   */
  app.post<{ Params: { id: string } }>(
    "/contracts/:id/cancel",
    { onRequest: app.requireCapability("contract:cancel") },
    async (request, reply) => {
      const parsed = cancelBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Explica el motivo con al menos 10 caracteres.",
        });
      }

      const actor = request.user!;
      const existing = app.db
        .select()
        .from(contracts)
        .where(eq(contracts.id, request.params.id))
        .get();

      if (!existing) {
        return reply.code(404).send({ error: "not_found", message: "Contrato no encontrado." });
      }

      if (existing.status !== "active") {
        return reply.code(409).send({
          error: "not_active",
          message: "Ese contrato ya no está vigente.",
        });
      }

      const closedAt = new Date().toISOString();

      app.db.transaction((tx) => {
        tx.update(contracts)
          .set({
            status: "cancelled",
            closedAt,
            closedReason: parsed.data.reason,
            updatedAt: closedAt,
          })
          .where(eq(contracts.id, existing.id))
          .run();

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "contract",
          entityId: existing.id,
          action: "cancel",
          reason: parsed.data.reason,
          before: { status: existing.status, closedAt: null },
          after: { status: "cancelled", closedAt },
        });
      });

      return reply.send({ ok: true, closedAt });
    },
  );
};
