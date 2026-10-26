import { randomUUID } from "node:crypto";

import { and, asc, eq, isNull } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { Db } from "../db/client.js";
import { contracts, moraManualCharges, users } from "../db/schema.js";
import { recordAudit } from "../lib/audit.js";
import { syncContractLifecycle } from "../lib/contractLifecycle.js";
import type { ContractTerms, SaleType } from "../lib/contracts.js";
import { buildSchedule } from "../lib/contracts.js";
import { loadMoraAccount } from "../lib/moraAccounts.js";
import { businessToday } from "../lib/time.js";

interface MoraRouteOptions {
  timeZone: string;
}

/**
 * «Cargar mora»: mora put on one contract by hand. See `moraManualCharges` in
 * src/db/schema.ts for what it is for, and lib/mora.ts for how it counts.
 *
 * Both writes are on `mora:charge` (supervisors by default, changeable in
 * Permisos), take a written reason and are filed in the Historial. The money
 * received never changes: only how the payments on that contract divide
 * between mora and cuotas.
 */

const chargeBody = z.object({
  /** 0 for the prima, otherwise the cuota's number. */
  installment: z.number().int().min(0),
  incurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Usa una fecha AAAA-MM-DD."),
  amountCents: z.number().int().positive(),
  reason: z.string().trim().min(10).max(500),
});

const removeBody = z.object({
  reason: z.string().trim().min(10).max(500),
});

/** Statuses that can still be charged: an open contract, or one paid off that a charge may reopen. */
const CHARGEABLE = new Set(["active", "paid_off"]);

type ContractRow = typeof contracts.$inferSelect;

function termsOf(row: ContractRow): ContractTerms {
  return {
    saleType: row.saleType as SaleType,
    salePriceCents: row.salePriceCents,
    downPaymentCents: row.downPaymentCents,
    termMonths: row.termMonths,
    monthlyPaymentCents: row.monthlyPaymentCents,
    dueDay: row.dueDay,
    signedOn: row.signedOn ?? row.createdAt.slice(0, 10),
    firstDueOn: row.firstDueOn,
  };
}

/** The prima (when there is one) and the cuotas, with the day each falls due. */
function itemsOf(row: ContractRow): Array<{ installment: number; dueOn: string }> {
  const terms = termsOf(row);
  const items = terms.downPaymentCents > 0 ? [{ installment: 0, dueOn: terms.signedOn }] : [];

  return [
    ...items,
    ...buildSchedule(terms).map((entry) => ({ installment: entry.number, dueOn: entry.dueOn })),
  ];
}

/** Why this contract can take no mora at all, or null when it can. */
function contractProblem(row: ContractRow): string | null {
  if (row.kind !== "contract" || row.saleType !== "financed") {
    return "Solo un contrato firmado a crédito lleva mora.";
  }

  if (!CHARGEABLE.has(row.status)) {
    return "Este contrato está cerrado; ya no se le carga mora.";
  }

  return null;
}

function snapshot(entry: { installment: number; incurredOn: string; amountCents: number }) {
  return {
    moraInstallment: entry.installment,
    moraIncurredOn: entry.incurredOn,
    amountCents: entry.amountCents,
  };
}

function readContract(db: Pick<Db, "select">, id: string): ContractRow | undefined {
  return db.select().from(contracts).where(eq(contracts.id, id)).get();
}

export const moraRoutes: FastifyPluginAsync<MoraRouteOptions> = async (app, options) => {
  const today = () => businessToday(options.timeZone);
  const at = () => ({ asOf: today(), timeZone: options.timeZone });

  /**
   * One contract's mora, for its panel: the mora put on by hand (with what is
   * still unpaid of each), the automatic mora on each cuota (so the form can
   * warn before the same cuota is charged twice), and the cuotas already due,
   * which are the ones «Cargar mora» offers.
   */
  app.get<{ Params: { id: string } }>(
    "/contracts/:id/mora",
    { onRequest: app.requireUser },
    async (request, reply) => {
      const row = readContract(app.db, request.params.id);

      if (!row) {
        return reply.code(404).send({ error: "not_found", message: "Ese contrato no existe." });
      }

      const account = loadMoraAccount(app.db, row.id, at());
      const automaticByInstallment: Record<number, number> = {};

      for (const charge of account?.charges ?? []) {
        if (charge.manualId === undefined) {
          automaticByInstallment[charge.installment] =
            (automaticByInstallment[charge.installment] ?? 0) + charge.amountCents;
        }
      }

      const manual = app.db
        .select({
          id: moraManualCharges.id,
          installment: moraManualCharges.installment,
          incurredOn: moraManualCharges.incurredOn,
          amountCents: moraManualCharges.amountCents,
          reason: moraManualCharges.reason,
          recordedAt: moraManualCharges.recordedAt,
          recordedBy: users.name,
        })
        .from(moraManualCharges)
        .innerJoin(users, eq(users.id, moraManualCharges.recordedBy))
        .where(and(eq(moraManualCharges.contractId, row.id), isNull(moraManualCharges.removedAt)))
        .orderBy(asc(moraManualCharges.incurredOn), asc(moraManualCharges.recordedAt))
        .all()
        .map((entry) => ({
          ...entry,
          pendingCents: account?.pendingByCharge[`mora:manual:${entry.id}`] ?? 0,
        }));

      const asOf = today();

      return {
        chargeable: contractProblem(row) === null,
        manual,
        automaticByInstallment,
        due: itemsOf(row).filter((item) => item.dueOn < asOf),
      };
    },
  );

  /** Put mora on one cuota of one contract. */
  app.post<{ Params: { id: string } }>(
    "/contracts/:id/mora",
    { onRequest: app.requireCapability("mora:charge") },
    async (request, reply) => {
      const parsed = chargeBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Elige la cuota, la fecha y un monto, y escribe un motivo de al menos 10 caracteres.",
        });
      }

      const body = parsed.data;
      const row = readContract(app.db, request.params.id);

      if (!row) {
        return reply.code(404).send({ error: "not_found", message: "Ese contrato no existe." });
      }

      const problem = contractProblem(row);

      if (problem) {
        return reply.code(409).send({ error: "not_chargeable", message: problem });
      }

      const item = itemsOf(row).find((entry) => entry.installment === body.installment);

      if (!item) {
        return reply.code(400).send({
          error: "invalid_installment",
          message: "Ese contrato no tiene esa cuota.",
        });
      }

      // Mora is for being late, so it can only start after the cuota fell due.
      if (body.incurredOn <= item.dueOn) {
        return reply.code(400).send({
          error: "too_early",
          message: `La fecha tiene que ser después del ${item.dueOn}, cuando venció esa cuota.`,
        });
      }

      if (body.incurredOn > today()) {
        return reply.code(400).send({
          error: "in_the_future",
          message: "La fecha no puede ser futura.",
        });
      }

      const actor = request.user!;
      const id = randomUUID();

      app.db.transaction((tx) => {
        tx.insert(moraManualCharges)
          .values({
            id,
            contractId: row.id,
            installment: body.installment,
            incurredOn: body.incurredOn,
            amountCents: body.amountCents,
            reason: body.reason,
            recordedBy: actor.id,
            recordedAt: new Date().toISOString(),
          })
          .run();

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "contract",
          entityId: row.id,
          action: "mora_charge",
          reason: body.reason,
          after: snapshot(body),
        });

        // A mora covered by a payment already made takes that money off the
        // price, which can reopen a contract that was paid off.
        syncContractLifecycle(tx, row.id, at());
      });

      return reply.code(201).send({ id });
    },
  );

  /** Take back a mora put on by mistake. Its row stays, marked removed. */
  app.post<{ Params: { id: string; chargeId: string } }>(
    "/contracts/:id/mora/:chargeId/remove",
    { onRequest: app.requireCapability("mora:charge") },
    async (request, reply) => {
      const parsed = removeBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Escribe un motivo de al menos 10 caracteres.",
        });
      }

      const existing = app.db
        .select()
        .from(moraManualCharges)
        .where(
          and(
            eq(moraManualCharges.id, request.params.chargeId),
            eq(moraManualCharges.contractId, request.params.id),
          ),
        )
        .get();

      if (!existing || existing.removedAt !== null) {
        return reply.code(404).send({ error: "not_found", message: "Esa mora no existe o ya se quitó." });
      }

      const actor = request.user!;

      app.db.transaction((tx) => {
        tx.update(moraManualCharges)
          .set({
            removedAt: new Date().toISOString(),
            removedBy: actor.id,
            removalReason: parsed.data.reason,
          })
          .where(eq(moraManualCharges.id, existing.id))
          .run();

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "contract",
          entityId: existing.contractId,
          action: "mora_remove",
          reason: parsed.data.reason,
          before: snapshot(existing),
        });

        // Paid mora goes back to the cuotas, which can settle the contract.
        syncContractLifecycle(tx, existing.contractId, at());
      });

      return reply.send({ ok: true });
    },
  );
};
