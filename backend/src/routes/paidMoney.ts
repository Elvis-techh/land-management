import { randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { contractRefunds, contracts, payments } from "../db/schema.js";
import { recordAudit } from "../lib/audit.js";
import { syncContractLifecycle } from "../lib/contractLifecycle.js";
import { CARRYOVER_METHOD, undecidedCents } from "../lib/paidMoney.js";
import { businessToday } from "../lib/time.js";

/**
 * «Trasladar lo pagado»: deciding what becomes of money paid on a contract an
 * adenda replaced, and recording the day a devolución is handed over. See
 * src/lib/paidMoney.ts for what each part is and why none of it touches the
 * old contract's payments or receipts.
 *
 * Everything here is filed in the Historial under one action, `paid_money`,
 * with the figures before and after, and needs `contract:amend` — the same
 * permission as the adenda whose money it settles.
 */

interface PaidMoneyRoutesOptions {
  /** IANA name — see `timeZone` in src/config/env.ts. Decides what "today" is. */
  timeZone: string;
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener el formato AAAA-MM-DD.")
  .refine((value) => value === new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10), {
    message: "Esa fecha no existe en el calendario.",
  });

const decideBody = z.object({
  /** What moves to the contract that replaced this one. Zero for none. */
  carryoverCents: z.number().int().nonnegative(),
  /** What it counts as there. */
  carryoverType: z.enum(["down_payment", "installment"]).default("down_payment"),
  /** The day it counts from there. Required when anything moves. */
  carryoverOn: isoDate.nullish(),
  /** What is owed back to whoever paid it. Zero for none. */
  refundCents: z.number().int().nonnegative(),
  reason: z.string().trim().min(10).max(500),
});

const returnBody = z.object({
  returnedOn: isoDate,
  method: z.enum(["cash", "transfer"]),
  reference: z.string().trim().max(120).nullish(),
});

const removeBody = z.object({ reason: z.string().trim().min(10).max(500) });

const lempiras = (cents: number) => `L ${(cents / 100).toLocaleString("es-HN")}`;

export const paidMoneyRoutes: FastifyPluginAsync<PaidMoneyRoutesOptions> = async (app, options) => {
  const today = () => businessToday(options.timeZone);
  const lifecycleAt = () => ({ asOf: today(), timeZone: options.timeZone });

  /**
   * Decide what becomes of what is still undecided on a replaced contract:
   * part or all of it moves to the contract that replaced it, part or all of
   * it is to be given back, and whatever is left stays as income.
   *
   * Can be done in steps — a traslado now, a devolución decided later — and
   * each step is held to what is still undecided, so no lempira is ever
   * counted twice.
   */
  app.post<{ Params: { id: string } }>(
    "/contracts/:id/paid-money",
    { onRequest: app.requireCapability("contract:amend") },
    async (request, reply) => {
      const parsed = decideBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Revisa los montos y explica el motivo (mínimo 10 caracteres).",
          issues: parsed.error.issues.map((issue) => issue.message),
        });
      }

      const body = parsed.data;
      const actor = request.user!;

      const source = request.db.select().from(contracts).where(eq(contracts.id, request.params.id)).get();

      if (!source) {
        return reply.code(404).send({ error: "not_found", message: "Contrato no encontrado." });
      }

      // Only a contract an adenda closed, for now. A cancelled contract whose
      // money goes to another lot is the same idea, with a destination to
      // choose — a later step.
      if (source.status !== "replaced") {
        return reply.code(409).send({
          error: "not_replaced",
          message:
            `${source.code} no está reemplazado por una adenda. Lo pagado se reparte aquí ` +
            "solo en un contrato que una adenda cerró.",
        });
      }

      if (body.carryoverCents + body.refundCents === 0) {
        return reply.code(400).send({
          error: "nothing_to_decide",
          message: "Indica cuánto pasa al contrato nuevo, cuánto se devuelve, o las dos cosas.",
        });
      }

      const undecided = undecidedCents(request.db, source.id);

      if (body.carryoverCents + body.refundCents > undecided) {
        return reply.code(400).send({
          error: "exceeds_paid",
          message:
            `De lo pagado en ${source.code} queda ${lempiras(undecided)} por decidir; ` +
            `${lempiras(body.carryoverCents + body.refundCents)} es más que eso.`,
          undecidedCents: undecided,
        });
      }

      const successor =
        body.carryoverCents === 0
          ? null
          : (request.db
              .select()
              .from(contracts)
              .where(eq(contracts.replacesContractId, source.id))
              .get() ?? null);

      if (body.carryoverCents > 0) {
        if (!successor || (successor.status !== "active" && successor.status !== "paid_off")) {
          return reply.code(409).send({
            error: "no_successor",
            message: `El contrato que reemplazó a ${source.code} ya no está vigente: no se le puede pasar dinero.`,
          });
        }

        if (!body.carryoverOn) {
          return reply.code(400).send({
            error: "date_required",
            message: "Indica desde qué día cuenta lo que pasa al contrato nuevo.",
          });
        }

        if (body.carryoverOn > today()) {
          return reply.code(400).send({
            error: "future_date",
            message: "La fecha del traslado no puede ser futura.",
          });
        }

        const signedOn = successor.signedOn ?? successor.createdAt.slice(0, 10);

        if (body.carryoverOn < signedOn) {
          return reply.code(400).send({
            error: "before_signing",
            message: `El traslado no puede ser anterior a la firma de ${successor.code} (${signedOn}).`,
          });
        }

        const paidThere = request.db
          .select({ amountCents: payments.amountCents })
          .from(payments)
          .where(and(eq(payments.contractId, successor.id), isNull(payments.reversedAt)))
          .all()
          .reduce((total, row) => total + row.amountCents, 0);
        const owedThere = Math.max(0, successor.salePriceCents - paidThere);

        // A traslado is not money anybody can be refunded from the new
        // contract later, so it must not leave that contract owing less than
        // nothing.
        if (body.carryoverCents > owedThere) {
          return reply.code(400).send({
            error: "overpayment",
            message: `${successor.code} solo debe ${lempiras(owedThere)}: no se le puede pasar más que eso.`,
            owedCents: owedThere,
          });
        }
      }

      const now = new Date().toISOString();
      const rest = undecided - body.carryoverCents - body.refundCents;

      request.db.transaction((tx) => {
        if (successor && body.carryoverCents > 0) {
          tx.insert(payments)
            .values({
              id: randomUUID(),
              contractId: successor.id,
              receiptId: null,
              amountCents: body.carryoverCents,
              originalAmountCents: body.carryoverCents,
              originalCurrency: "HNL",
              exchangeRate: "1",
              paidOn: body.carryoverOn!,
              method: CARRYOVER_METHOD,
              reference: null,
              type: body.carryoverType,
              notes: `Trasladado de ${source.code}`,
              recordedBy: actor.id,
              transferredFromContractId: source.id,
              createdAt: now,
            })
            .run();

          // It can cover the whole new price, which settles the contract.
          syncContractLifecycle(tx, successor.id, lifecycleAt());
        }

        if (body.refundCents > 0) {
          tx.insert(contractRefunds)
            .values({
              id: randomUUID(),
              contractId: source.id,
              amountCents: body.refundCents,
              reason: body.reason,
              recordedBy: actor.id,
              createdAt: now,
            })
            .run();
        }

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "contract",
          entityId: source.id,
          action: "paid_money",
          reason: body.reason,
          before: { keptCents: undecided },
          after: {
            keptCents: rest,
            ...(body.carryoverCents > 0
              ? { carriedCents: body.carryoverCents, carriedTo: successor!.code }
              : {}),
            ...(body.refundCents > 0 ? { refundCents: body.refundCents } : {}),
          },
        });
      });

      return reply.code(201).send({ undecidedCents: rest });
    },
  );

  /** Take a traslado back: the money is undecided on the old contract again. */
  app.post<{ Params: { paymentId: string } }>(
    "/carryovers/:paymentId/remove",
    { onRequest: app.requireCapability("contract:amend") },
    async (request, reply) => {
      const parsed = removeBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Explica por qué se quita el traslado (mínimo 10 caracteres).",
        });
      }

      const row = request.db.select().from(payments).where(eq(payments.id, request.params.paymentId)).get();

      if (!row || row.transferredFromContractId === null) {
        return reply.code(404).send({ error: "not_found", message: "Ese traslado no existe." });
      }

      if (row.reversedAt !== null) {
        return reply.code(409).send({ error: "already_removed", message: "Ese traslado ya se quitó." });
      }

      const actor = request.user!;
      const now = new Date().toISOString();
      const to = request.db
        .select({ code: contracts.code })
        .from(contracts)
        .where(eq(contracts.id, row.contractId))
        .get();
      const undecided = undecidedCents(request.db, row.transferredFromContractId);

      request.db.transaction((tx) => {
        tx.update(payments)
          .set({ reversedAt: now, reversedBy: actor.id, reversalReason: parsed.data.reason })
          .where(eq(payments.id, row.id))
          .run();

        // It may have been what settled the new contract.
        syncContractLifecycle(tx, row.contractId, lifecycleAt());

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "contract",
          entityId: row.transferredFromContractId!,
          action: "paid_money",
          reason: parsed.data.reason,
          before: { keptCents: undecided, carriedCents: row.amountCents, carriedTo: to?.code ?? null },
          after: { keptCents: undecided + row.amountCents, carriedCents: 0, carriedTo: to?.code ?? null },
        });
      });

      return reply.send({ ok: true });
    },
  );

  /** The day a devolución was handed over: from then on it is money gone out. */
  app.post<{ Params: { id: string } }>(
    "/refunds/:id/return",
    { onRequest: app.requireCapability("contract:amend") },
    async (request, reply) => {
      const parsed = returnBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Indica el día y cómo se devolvió el dinero.",
          issues: parsed.error.issues.map((issue) => issue.message),
        });
      }

      const refund = request.db
        .select()
        .from(contractRefunds)
        .where(eq(contractRefunds.id, request.params.id))
        .get();

      if (!refund || refund.removedAt !== null) {
        return reply.code(404).send({ error: "not_found", message: "Esa devolución no existe." });
      }

      if (refund.returnedOn !== null) {
        return reply.code(409).send({
          error: "already_returned",
          message: `Esa devolución ya se registró como entregada el ${refund.returnedOn}.`,
        });
      }

      if (parsed.data.returnedOn > today()) {
        return reply.code(400).send({
          error: "future_date",
          message: "Registra la devolución el día en que se entregó, no antes.",
        });
      }

      const actor = request.user!;
      const now = new Date().toISOString();
      const reference = parsed.data.reference?.trim() ? parsed.data.reference.trim() : null;

      request.db.transaction((tx) => {
        tx.update(contractRefunds)
          .set({
            returnedOn: parsed.data.returnedOn,
            method: parsed.data.method,
            reference,
            returnedBy: actor.id,
            returnedAt: now,
          })
          .where(eq(contractRefunds.id, refund.id))
          .run();

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "contract",
          entityId: refund.contractId,
          action: "paid_money",
          before: { refundCents: refund.amountCents, refundReturnedOn: null },
          after: {
            refundCents: refund.amountCents,
            refundReturnedOn: parsed.data.returnedOn,
            method: parsed.data.method,
            ...(reference ? { reference } : {}),
          },
        });
      });

      return reply.send({ ok: true });
    },
  );

  /** A devolución entered by mistake. The money is undecided again. */
  app.post<{ Params: { id: string } }>(
    "/refunds/:id/remove",
    { onRequest: app.requireCapability("contract:amend") },
    async (request, reply) => {
      const parsed = removeBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Explica por qué se quita la devolución (mínimo 10 caracteres).",
        });
      }

      const refund = request.db
        .select()
        .from(contractRefunds)
        .where(eq(contractRefunds.id, request.params.id))
        .get();

      if (!refund || refund.removedAt !== null) {
        return reply.code(404).send({ error: "not_found", message: "Esa devolución no existe." });
      }

      const actor = request.user!;
      const now = new Date().toISOString();
      const undecided = undecidedCents(request.db, refund.contractId);

      request.db.transaction((tx) => {
        tx.update(contractRefunds)
          .set({ removedAt: now, removedBy: actor.id, removalReason: parsed.data.reason })
          .where(eq(contractRefunds.id, refund.id))
          .run();

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "contract",
          entityId: refund.contractId,
          action: "paid_money",
          reason: parsed.data.reason,
          before: { keptCents: undecided, refundCents: refund.amountCents, refundReturnedOn: refund.returnedOn },
          after: { keptCents: undecided + refund.amountCents, refundCents: 0 },
        });
      });

      return reply.send({ ok: true });
    },
  );
};
