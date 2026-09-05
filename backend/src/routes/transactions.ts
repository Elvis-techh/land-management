import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { Db } from "../db/client.js";
import { contracts, customers, lots, payments, projects, receipts, users } from "../db/schema.js";
import { splitEvenly } from "../lib/allocation.js";
import type { AllocationTarget } from "../lib/allocation.js";
import { attachmentsForPayment, attachmentsForReceipts } from "../lib/storedFiles.js";
import { recordAudit } from "../lib/audit.js";
import { syncContractLifecycle } from "../lib/contractLifecycle.js";
import { openContract } from "../lib/holding.js";
import { replayContract } from "../lib/ledger.js";

/** Today as a YYYY-MM-DD calendar date. */
const today = () => new Date().toISOString().slice(0, 10);

const PAYMENT_METHODS = ["cash", "transfer", "card"] as const;
const PAYMENT_TYPES = ["down_payment", "installment", "full_payment", "adjustment"] as const;

/**
 * Every posted transaction, with the context needed to make sense of it.
 *
 * One endpoint behind BOTH views of the Recibos screen — the flat list by date
 * and the grouped list by customer. Grouping is a question about presentation,
 * so it is answered in the browser from a single ordered list rather than by a
 * second endpoint that could disagree with the first about what exists.
 *
 * Payments with no receipt are included. They are real money, they count in
 * every balance, and leaving them out of the transactions screen would mean
 * this list disagreed with the contract it belongs to.
 */
const transactionsQuery = (db: Db) =>
  db
    .select({
      id: payments.id,
      amount: payments.amountCents,
      originalAmount: payments.originalAmountCents,
      originalCurrency: payments.originalCurrency,
      exchangeRate: payments.exchangeRate,
      paidOn: payments.paidOn,
      method: payments.method,
      type: payments.type,
      reference: payments.reference,
      notes: payments.notes,
      reversedAt: payments.reversedAt,
      reversalReason: payments.reversalReason,
      createdAt: payments.createdAt,
      contractId: contracts.id,
      contractCode: contracts.code,
      contractStatus: contracts.status,
      lotCode: lots.code,
      projectName: projects.name,
      customerId: customers.id,
      customerName: customers.fullName,
      customerIdentification: customers.identification,
      receiptId: receipts.id,
      receiptCode: receipts.code,
      receiptVoidedAt: receipts.voidedAt,
      recordedByName: users.name,
    })
    .from(payments)
    .innerJoin(contracts, eq(contracts.id, payments.contractId))
    .innerJoin(lots, eq(lots.id, contracts.lotId))
    .innerJoin(projects, eq(projects.id, lots.projectId))
    .innerJoin(customers, eq(customers.id, contracts.customerId))
    .innerJoin(users, eq(users.id, payments.recordedBy))
    .leftJoin(receipts, eq(receipts.id, payments.receiptId));

/**
 * What a transaction edit may change.
 *
 * Note what is NOT here: the contract. Moving money from one lot to another is
 * not an edit, it is a reversal and a new payment — the two contracts have
 * separate balances, separate receipts and, quite possibly, separate customers,
 * and one UPDATE that silently rewrites both ledgers is not something anybody
 * could explain afterwards.
 */
const editBody = z.object({
  amountCents: z.number().int().positive(),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Usa una fecha AAAA-MM-DD."),
  method: z.enum(PAYMENT_METHODS),
  type: z.enum(PAYMENT_TYPES),
  reference: z.string().trim().max(120).nullish(),
  notes: z.string().trim().max(300).nullish(),
  /**
   * Required, and at least a sentence.
   *
   * This is the one place in the app where a posted financial fact is rewritten
   * in place rather than reversed, so the audit entry is the only record that
   * the old figure ever existed. "Ajuste" tells a reader nothing; the rule the
   * app already applies to cancelling a contract applies here for the same
   * reason.
   */
  reason: z.string().trim().min(10).max(500),
  /** Deliberate acknowledgement that the new amount exceeds what is owed. */
  allowOverpayment: z.boolean().default(false),
});

export const transactionRoutes: FastifyPluginAsync = async (app) => {
  app.get("/transactions", { onRequest: app.requireUser }, async () => {
    const rows = transactionsQuery(app.db)
      .orderBy(desc(payments.paidOn), desc(payments.createdAt))
      .all();

    /*
     * The comprobantes, so a row can show one without being opened.
     *
     * The whole point of the thumbnail on a transaction row is that checking
     * "is this the right slip?" costs a glance rather than a click, a fetch and
     * a wait — so the list has to arrive already knowing what is attached. One
     * extra query for the entire screen, not one per row.
     *
     * Only the metadata travels. The bytes are fetched per file, lazily, by the
     * browser, from /api/attachments/:id/file — a hundred rows must not mean a
     * hundred photographs on the wire before anything is drawn.
     */
    const byReceipt = attachmentsForReceipts(
      app.db,
      [...new Set(rows.map((row) => row.receiptId).filter((id) => id !== null))],
    );

    return {
      transactions: rows.map((row) => ({
        ...row,
        attachments:
          row.receiptId === null
            ? []
            : attachmentsForPayment(byReceipt.get(row.receiptId), row.id),
      })),
    };
  });

  /**
   * How one amount would divide across everything a customer is paying on.
   *
   * The customer hands over a single figure for three lots; this proposes where
   * it lands. The rule itself is in src/lib/allocation.ts: equal shares rounded
   * down to whole hundreds, with the remainder going to the lot that owes the
   * most — which is what makes the lots even out over a term instead of one
   * always taking the odd money.
   *
   * A PROPOSAL. Nothing is written, and the screen lets every line be
   * overridden before the receipt is issued.
   *
   * Distinct from the sale-group split already in routes/contracts.ts: that one
   * divides across the lots of ONE purchase. This divides across everything the
   * person currently owes on, which is what somebody paying at a window
   * actually means when they hand over a lump sum.
   */
  app.get<{ Params: { id: string }; Querystring: { amountCents?: string } }>(
    "/customers/:id/split",
    { onRequest: app.requireUser },
    async (request, reply) => {
      const amountCents = Number(request.query.amountCents);

      if (!Number.isInteger(amountCents) || amountCents <= 0) {
        return reply.code(400).send({
          error: "invalid_amount",
          message: "Indica el monto a repartir, en centavos.",
        });
      }

      const customer = app.db
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.id, request.params.id))
        .get();

      if (!customer) {
        return reply
          .code(404)
          .send({ error: "customer_not_found", message: "Ese cliente no existe." });
      }

      const open = app.db
        .select({
          id: contracts.id,
          code: contracts.code,
          salePriceCents: contracts.salePriceCents,
          lotCode: lots.code,
          projectName: projects.name,
          paidToDateCents: sql<number>`
            COALESCE((
              SELECT SUM(${payments.amountCents})
              FROM ${payments}
              WHERE ${payments.contractId} = ${contracts.id}
                AND ${payments.reversedAt} IS NULL
            ), 0)
          `,
        })
        .from(contracts)
        .innerJoin(lots, eq(lots.id, contracts.lotId))
        .innerJoin(projects, eq(projects.id, lots.projectId))
        // Contracts still being serviced — a paid-off or lapsed one has
        // nothing left to pay, so it is not a split target.
        .where(and(eq(contracts.customerId, request.params.id), openContract(today())))
        .all();

      const targets: AllocationTarget[] = open.map((contract) => ({
        contractId: contract.id,
        code: contract.code,
        balanceCents: Math.max(0, contract.salePriceCents - contract.paidToDateCents),
      }));

      const result = splitEvenly(amountCents, targets);
      const byContract = new Map(
        result.allocations.map((allocation) => [allocation.contractId, allocation.amountCents]),
      );

      return {
        lines: open
          .map((contract) => {
            const amount = byContract.get(contract.id) ?? 0;
            const balanceBefore = Math.max(0, contract.salePriceCents - contract.paidToDateCents);

            return {
              contractId: contract.id,
              contractCode: contract.code,
              lotCode: contract.lotCode,
              projectName: contract.projectName,
              amountCents: amount,
              balanceBefore,
              balanceAfter: Math.max(0, balanceBefore - amount),
            };
          })
          // Contracts receiving nothing are still listed, so the screen can show
          // a paid-off lot sitting at zero rather than silently omitting it and
          // leaving somebody to wonder where their third lot went.
          .sort((a, b) => a.lotCode.localeCompare(b.lotCode, "es")),
        unallocatedCents: result.unallocatedCents,
      };
    },
  );

  /**
   * Correct a posted transaction.
   *
   * This is the one place in Lindero where a financial row is rewritten rather
   * than reversed, and it exists because the owner asked for exactly this: find
   * out two months later that a payment was really L 10,000, change it, and
   * have every figure after it re-adjust. Because balances are replayed rather
   * than stored, they do — see src/lib/ledger.ts.
   *
   * What protects it is that nothing is LOST: the before and after are both
   * written to the audit history along with a required reason, so the previous
   * figure is still answerable for. That is the trade being made deliberately —
   * an editable amount with a full paper trail, rather than an immutable row
   * that forces a reversal-plus-repost for a simple typo.
   *
   * A reversed payment cannot be edited. It is already out of the accounts, and
   * editing the amount of money that is not counted is meaningless.
   */
  app.patch<{ Params: { id: string } }>(
    "/transactions/:id",
    /*
     * `payment:edit`, NOT `payment:reverse`.
     *
     * The two used to share a permission, and the label on that permission —
     * "Reversar pagos: corrige un pago escribiendo una reversa" — described only
     * half of what it handed over. A reversal writes a second, visible entry and
     * leaves the original standing; this route rewrites a posted figure in
     * place. The old amount survives only in the audit history, which is a
     * different and larger amount of trust.
     *
     * The app already draws this exact line between `contract:edit` and
     * `contract:reprice`: moving a due date and moving a balance are not the
     * same permission. Same reasoning, same split.
     */
    { onRequest: app.requireCapability("payment:edit") },
    async (request, reply) => {
      const parsed = editBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_transaction",
          message: parsed.error.issues[0]?.message ?? "Revisa los datos de la transacción.",
        });
      }

      const body = parsed.data;

      const existing = app.db
        .select()
        .from(payments)
        .where(eq(payments.id, request.params.id))
        .get();

      if (!existing) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "Esa transacción no existe." });
      }

      if (existing.reversedAt) {
        return reply.code(409).send({
          error: "already_reversed",
          message: "Esa transacción está revertida y ya no cuenta en los saldos.",
        });
      }

      const contract = app.db
        .select({
          id: contracts.id,
          code: contracts.code,
          salePriceCents: contracts.salePriceCents,
        })
        .from(contracts)
        .where(eq(contracts.id, existing.contractId))
        .get();

      if (!contract) {
        return reply
          .code(404)
          .send({ error: "contract_not_found", message: "El contrato ya no existe." });
      }

      if (!body.allowOverpayment) {
        // The balance WITHOUT this payment, so the check asks "would the new
        // amount overpay", not "does it differ from the old one".
        const others = app.db
          .select({
            id: payments.id,
            amountCents: payments.amountCents,
            paidOn: payments.paidOn,
            createdAt: payments.createdAt,
            reversedAt: payments.reversedAt,
          })
          .from(payments)
          .where(sql`${payments.contractId} = ${contract.id} AND ${payments.id} <> ${existing.id}`)
          .all();

        const room = replayContract({
          salePriceCents: contract.salePriceCents,
          credits: others,
        }).balanceCents;

        if (body.amountCents > room) {
          return reply.code(409).send({
            error: "overpayment",
            message:
              `Sin esta transacción el contrato ${contract.code} debe ` +
              `L ${(room / 100).toLocaleString("es-HN")}. ` +
              "Confirma el sobrepago si el cliente realmente entregó de más.",
            balanceCents: room,
          });
        }
      }

      const before = {
        amountCents: existing.amountCents,
        paidOn: existing.paidOn,
        method: existing.method,
        type: existing.type,
        reference: existing.reference,
        notes: existing.notes,
      };

      const after = {
        amountCents: body.amountCents,
        paidOn: body.paidOn,
        method: body.method,
        type: body.type,
        reference: body.reference ?? null,
        notes: body.notes ?? null,
      };

      app.db.transaction((tx) => {
        tx.update(payments)
          .set({
            ...after,
            // The original currency figure travels with the amount. A payment
            // recorded in lempiras keeps them equal; one taken in dollars keeps
            // the rate it was settled at, so re-deriving the dollar figure from
            // the stored rate is the only answer that stays true to what the
            // customer actually handed over.
            originalAmountCents:
              existing.originalCurrency === "HNL"
                ? body.amountCents
                : Math.round(body.amountCents / Number(existing.exchangeRate)),
          })
          .where(eq(payments.id, existing.id))
          .run();

        recordAudit(tx, {
          actorId: request.user!.id,
          entityType: "payment",
          entityId: existing.id,
          action: "update",
          reason: body.reason,
          before,
          after,
        });

        // A corrected amount can close a contract (down to zero) or reopen a
        // paid-off one (corrected below the price again).
        syncContractLifecycle(tx, existing.contractId, request.user!.id);
      });

      const updated = transactionsQuery(app.db).where(eq(payments.id, existing.id)).get();

      return { transaction: updated };
    },
  );
};
