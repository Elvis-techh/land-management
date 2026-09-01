import { randomUUID } from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { Db } from "../db/client.js";
import { contracts, customers, lots, payments, projects, receipts } from "../db/schema.js";
import { splitEvenly } from "../lib/allocation.js";
import { recordAudit } from "../lib/audit.js";
import type { ContractTerms, SaleType } from "../lib/contracts.js";
import {
  assessContract,
  buildSchedule,
  financedCents,
  firstDueDate,
  isReservationExpired,
} from "../lib/contracts.js";
import { roleCan } from "../lib/capabilities.js";
import { syncContractLifecycle } from "../lib/contractLifecycle.js";
import { holdsLot, openContract } from "../lib/holding.js";

/** Today, as a calendar date. Every due date in the app is a date, not an instant. */
const today = () => new Date().toISOString().slice(0, 10);

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
      closedSettlement: contracts.closedSettlement,
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
    /**
     * A reservation whose `expiresOn` has passed. The row still reads
     * `status = 'active'` — nothing rewrites it — but the hold has lapsed: the
     * lot is available again and the Contratos screen shows this one as
     * "Vencida". Derived here, like every other status in the app.
     */
    expired: isReservationExpired(row.kind, row.expiresOn, asOf),
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
    /** "none" | "held" | "refunded" — what became of money paid, on cancellation. */
    closedSettlement: row.closedSettlement,
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
  /**
   * What happens to money the customer has already paid:
   *
   * - "none"     — it stays as income; nothing is reversed.
   * - "held"     — it stays counted for now, flagged for a decision later.
   * - "refunded" — the payments are reversed here and now, so they stop
   *                counting anywhere, and any receipt they fully covered is
   *                voided. Needs the `payment:reverse` capability.
   *
   * Required when anything has been paid — the handler rejects a missing one
   * with `settlement_required` rather than the schema, so it can say why.
   */
  settlement: z.enum(["none", "held", "refunded"]).optional(),
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
 *
 * The suffix is compared as an INTEGER, not as text. A text sort puts
 * "CT-2026-999" above "CT-2026-1000" — nine is a bigger character than one — so
 * ordering by the string hands out 1000 a second time the moment the
 * thousandth contract of a year exists, and every create after that collides
 * on the unique index for the rest of the year. `substr(code, N)` takes
 * everything after the `CT-YYYY-` prefix; `CAST(... AS INTEGER)` then makes 1000
 * genuinely larger than 999.
 *
 * Takes any handle with `select` so it can run INSIDE the insert transaction,
 * where the write lock keeps two racing creates from reading the same maximum.
 */
function nextContractCode(db: Pick<Db, "select">, year: string): string {
  const prefix = `CT-${year}-`;

  const row = db
    .select({
      max: sql<number | null>`MAX(CAST(substr(${contracts.code}, ${prefix.length + 1}) AS INTEGER))`,
    })
    .from(contracts)
    .where(sql`${contracts.code} LIKE ${`${prefix}%`}`)
    .get();

  return `${prefix}${String((row?.max ?? 0) + 1).padStart(3, "0")}`;
}

/** True for the SQLite error a violated UNIQUE index throws. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    return (error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE";
  }
  return String(error).includes("UNIQUE");
}

/**
 * Run a write, and run it once more if it lost a race for a unique value.
 *
 * `nextContractCode` reads MAX(number) + 1 under the write lock, but two
 * transactions can still both read the same maximum before either commits — the
 * loser then hits the unique index on `code`. One retry recomputes against the
 * row the winner just wrote and lands on the next free number.
 */
function withUniqueRetry<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (isUniqueViolation(error)) {
      return run();
    }
    throw error;
  }
}

export const contractRoutes: FastifyPluginAsync = async (app) => {
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
        .where(and(eq(contracts.saleGroupId, request.params.groupId), openContract(asOf)))
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
      // its own once two staff are entering contracts at the same time. A
      // reservation that has passed its expiry date is not a holder — the lot
      // is free again — so a lapsed hold no longer blocks the sale it was meant
      // to make room for. A paid-off contract still holds: the lot is sold.
      const holder = app.db
        .select({ code: contracts.code })
        .from(contracts)
        .where(and(eq(contracts.lotId, lot.id), holdsLot(today())))
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
      const year = parsed.data.signedOn.slice(0, 4);

      // The number is allocated INSIDE the transaction that inserts, under the
      // write lock, and the whole thing retries once if it still races another
      // create onto the same number — see `withUniqueRetry`.
      const created = withUniqueRetry(() =>
        app.db.transaction((tx) => {
          // The first lot of a purchase was written before anybody knew a
          // second one was coming, so it has no group id. Stamping it here is
          // what turns two separate contracts into one purchase.
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
              code: nextContractCode(tx, year),
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
        }),
      );

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

      if (existing.status === "cancelled" || existing.status === "defaulted") {
        // A closed contract is history. Editing it would rewrite what the
        // parties are recorded as having agreed. A `paid_off` contract, on the
        // other hand, can still be corrected — a reprice upward reopens it (see
        // the lifecycle sync below).
        return reply.code(409).send({
          error: "not_active",
          message: "Este contrato está cerrado y ya no admite cambios.",
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

        // A new price can push the balance to zero (settling the contract) or,
        // on a paid-off contract repriced upward, reopen it.
        syncContractLifecycle(tx, existing.id, actor.id);

        return next;
      });

      return reply.send({ contract: { id: updated.id, code: updated.code } });
    },
  );

  /**
   * Close a contract — either a cancellation (a sale unwound) or a default (the
   * customer declared unable to keep paying). The two share everything: the lot
   * comes back on its own because availability is derived, nothing is deleted,
   * and the same question is asked about money already paid — refund it, hold
   * it, or keep it as income.
   *
   * They differ only in the status written, the capability required, the audit
   * action, and the wording. `close` is that shared body; the two routes below
   * are thin.
   */
  const close = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    kind: {
      newStatus: "cancelled" | "defaulted";
      action: "cancel" | "default";
      /** e.g. "cancelar" / "declarar incumplido" — used in the 403 wording. */
      verb: string;
    },
  ) => {
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

    // `active` or `paid_off` — both are contracts that still hold a lot and can
    // be closed. An already-cancelled or defaulted one is done.
    if (existing.status !== "active" && existing.status !== "paid_off") {
      return reply.code(409).send({
        error: "not_active",
        message: "Ese contrato ya está cerrado.",
      });
    }

    // Every non-reversed payment on this contract, with the receipt it sits on.
    // What the customer has already paid, and what a "refund" would touch.
    const contractPayments = app.db
      .select({
        id: payments.id,
        amountCents: payments.amountCents,
        receiptId: payments.receiptId,
      })
      .from(payments)
      .where(and(eq(payments.contractId, existing.id), sql`${payments.reversedAt} IS NULL`))
      .all();

    const paidToDateCents = contractPayments.reduce((sum, p) => sum + p.amountCents, 0);

    // The settlement question only exists once money has changed hands. With
    // nothing paid there is nothing to decide, and `closed_settlement` stays null.
    let settlement: "none" | "held" | "refunded" | null = null;

    if (paidToDateCents > 0) {
      if (!parsed.data.settlement) {
        return reply.code(400).send({
          error: "settlement_required",
          message:
            `${existing.code} tiene L ${(paidToDateCents / 100).toLocaleString("es-HN")} ` +
            "pagados. Indica qué pasa con ese dinero: reembolso, retención temporal o " +
            "que quede como ingreso.",
        });
      }

      settlement = parsed.data.settlement;

      // Reversing money is a bigger power than closing a contract, so the refund
      // option carries its own capability.
      if (settlement === "refunded" && !roleCan(app.db, actor.role, "payment:reverse")) {
        return reply.code(403).send({
          error: "forbidden",
          message:
            `Tu usuario puede ${kind.verb} contratos, pero no revertir pagos. ` +
            "Elige otra opción o pide a un supervisor que registre el reembolso.",
        });
      }
    }

    const closedAt = new Date().toISOString();
    const reversedPaymentIds: string[] = [];
    const voidedReceiptIds: string[] = [];

    app.db.transaction((tx) => {
      tx.update(contracts)
        .set({
          status: kind.newStatus,
          closedAt,
          closedReason: parsed.data.reason,
          closedSettlement: settlement,
          updatedAt: closedAt,
        })
        .where(eq(contracts.id, existing.id))
        .run();

      if (settlement === "refunded" && contractPayments.length > 0) {
        const note = `Contrato ${existing.code} ${
          kind.newStatus === "defaulted" ? "incumplido" : "cancelado"
        } con reembolso`;

        // The payments keep their amount, date and rate — they just stop
        // counting, exactly as a receipt void does. Every balance in the app
        // already filters on `reversed_at IS NULL`.
        tx.update(payments)
          .set({ reversedAt: closedAt, reversedBy: actor.id, reversalReason: note })
          .where(and(eq(payments.contractId, existing.id), sql`${payments.reversedAt} IS NULL`))
          .run();

        for (const p of contractPayments) {
          reversedPaymentIds.push(p.id);
        }

        // A receipt whose payments were all for this contract now carries
        // nothing — void it too, so it reads as a void rather than as a receipt
        // whose numbers quietly shrank. A receipt shared with another lot (a
        // sale group) keeps standing; only its closed line is gone.
        const receiptIds = [
          ...new Set(contractPayments.map((p) => p.receiptId).filter((x): x is string => !!x)),
        ];

        for (const receiptId of receiptIds) {
          const stillActive = tx
            .select({ n: sql<number>`COUNT(*)` })
            .from(payments)
            .where(and(eq(payments.receiptId, receiptId), sql`${payments.reversedAt} IS NULL`))
            .get();

          if ((stillActive?.n ?? 0) === 0) {
            tx.update(receipts)
              .set({ voidedAt: closedAt, voidReason: note, voidedBy: actor.id })
              .where(and(eq(receipts.id, receiptId), sql`${receipts.voidedAt} IS NULL`))
              .run();
            voidedReceiptIds.push(receiptId);
          }
        }
      }

      recordAudit(tx, {
        actorId: actor.id,
        entityType: "contract",
        entityId: existing.id,
        action: kind.action,
        reason: parsed.data.reason,
        before: { status: existing.status, closedAt: null, paidToDateCents },
        after: {
          status: kind.newStatus,
          closedAt,
          settlement,
          ...(settlement === "refunded"
            ? { reversedPaymentIds, voidedReceiptIds, refundedCents: paidToDateCents }
            : {}),
        },
      });
    });

    return reply.send({
      ok: true,
      closedAt,
      paidToDateCents,
      settlement,
      refundedCents: settlement === "refunded" ? paidToDateCents : 0,
    });
  };

  app.post<{ Params: { id: string } }>(
    "/contracts/:id/cancel",
    { onRequest: app.requireCapability("contract:cancel") },
    (request, reply) => close(request, reply, { newStatus: "cancelled", action: "cancel", verb: "cancelar" }),
  );

  /**
   * Declare a contract uncollectable — the customer defaulted.
   *
   * Distinct from a cancellation on purpose: a cancellation is a sale unwound
   * by agreement, a default is the business writing off what it is owed. Owner
   * only, and locked there (see LOCKED_CAPABILITIES) — it is a decision about
   * money being given up on, not one to delegate. Everything else — the lot
   * coming back, the settlement question, the refund path — is shared with
   * cancellation.
   */
  app.post<{ Params: { id: string } }>(
    "/contracts/:id/default",
    { onRequest: app.requireCapability("contract:default") },
    (request, reply) =>
      close(request, reply, { newStatus: "defaulted", action: "default", verb: "declarar incumplidos" }),
  );
};
