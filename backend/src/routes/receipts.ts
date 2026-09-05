import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import multipart from "@fastify/multipart";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { Db } from "../db/client.js";
import {
  attachments,
  contracts,
  customers,
  lots,
  payments,
  projects,
  receipts,
  users,
} from "../db/schema.js";
import {
  MAX_ATTACHMENTS_PER_RECEIPT,
  MAX_ATTACHMENT_BYTES,
  isAllowedContentType,
  isValidStorageKey,
  safeDisplayName,
  storageKeyFor,
} from "../lib/attachments.js";
import { recordAudit } from "../lib/audit.js";
import { syncContractLifecycle } from "../lib/contractLifecycle.js";
import type { ContractTerms, SaleType } from "../lib/contracts.js";
import { appliedInstallments, buildSchedule } from "../lib/contracts.js";
import { orderLedger, receiptFigures, replayContract } from "../lib/ledger.js";
import {
  allocateReceiptCode,
  generateLookupCode,
  nextReceiptNumber,
  toStoredLookupCode,
} from "../lib/receipts.js";

const PAYMENT_METHODS = ["cash", "transfer", "card"] as const;
const PAYMENT_TYPES = ["down_payment", "installment", "full_payment", "adjustment"] as const;

/* -------------------------------------------------------------------------- */
/* Reading the ledger                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Every payment belonging to a set of customers, in one query.
 *
 * The whole history is loaded, not just the receipted part, because a balance
 * is a replay from the beginning — see src/lib/ledger.ts. Loading it per
 * receipt instead would be the N+1 that turns a list of fifty receipts into
 * fifty round trips, so the callers below fetch once and replay in memory.
 */
function creditsForCustomers(db: Db, customerIds: readonly string[]) {
  if (customerIds.length === 0) {
    return [];
  }

  return db
    .select({
      id: payments.id,
      contractId: payments.contractId,
      customerId: contracts.customerId,
      amountCents: payments.amountCents,
      paidOn: payments.paidOn,
      createdAt: payments.createdAt,
      reversedAt: payments.reversedAt,
      receiptId: payments.receiptId,
      type: payments.type,
      method: payments.method,
    })
    .from(payments)
    .innerJoin(contracts, eq(contracts.id, payments.contractId))
    .where(inArray(contracts.customerId, customerIds))
    .all();
}

type CustomerCredit = ReturnType<typeof creditsForCustomers>[number];

/** The sale price of every contract named, so the ledger has its opening charge. */
function salePricesFor(db: Db, contractIds: readonly string[]): Map<string, number> {
  if (contractIds.length === 0) {
    return new Map();
  }

  const rows = db
    .select({ id: contracts.id, salePriceCents: contracts.salePriceCents })
    .from(contracts)
    .where(inArray(contracts.id, contractIds))
    .all();

  return new Map(rows.map((row) => [row.id, row.salePriceCents]));
}

/**
 * The current balance of one contract, replayed rather than read.
 *
 * Used by the write path to decide whether an amount would overpay. It agrees
 * with the `salePrice − SUM(payments)` that routes/contracts.ts computes in SQL
 * because, with no additional charges in the system yet, they are the same
 * arithmetic — see the note on `LedgerCharge`. Going through the ledger here
 * means the day charges DO exist, this check moves with them.
 */
function contractBalanceCents(db: Db, contractId: string, salePriceCents: number): number {
  const credits = db
    .select({
      id: payments.id,
      amountCents: payments.amountCents,
      paidOn: payments.paidOn,
      createdAt: payments.createdAt,
      reversedAt: payments.reversedAt,
    })
    .from(payments)
    .where(eq(payments.contractId, contractId))
    .all();

  return replayContract({ salePriceCents, credits }).balanceCents;
}

/* -------------------------------------------------------------------------- */
/* Presenting a receipt                                                        */
/* -------------------------------------------------------------------------- */

const receiptsListQuery = (db: Db) =>
  db
    .select({
      id: receipts.id,
      number: receipts.number,
      code: receipts.code,
      lookupCode: receipts.lookupCode,
      issuedOn: receipts.issuedOn,
      note: receipts.note,
      voidedAt: receipts.voidedAt,
      voidReason: receipts.voidReason,
      supersededById: receipts.supersededById,
      createdAt: receipts.createdAt,
      customerId: customers.id,
      customerName: customers.fullName,
      customerIdentification: customers.identification,
      customerPhone: customers.phone,
      issuedById: users.id,
      issuedByName: users.name,
    })
    .from(receipts)
    .innerJoin(customers, eq(customers.id, receipts.customerId))
    .innerJoin(users, eq(users.id, receipts.issuedBy));

type ReceiptRow = ReturnType<ReturnType<typeof receiptsListQuery>["all"]>[number];

interface AttachmentRow {
  id: string;
  receiptId: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
}

/**
 * The contract detail a receipt line shows, fetched for the contracts a batch
 * of receipts actually touches.
 */
function contractDetailsFor(db: Db, contractIds: readonly string[]) {
  if (contractIds.length === 0) {
    return new Map<string, ContractDetail>();
  }

  const rows = db
    .select({
      id: contracts.id,
      code: contracts.code,
      saleType: contracts.saleType,
      salePriceCents: contracts.salePriceCents,
      downPaymentCents: contracts.downPaymentCents,
      termMonths: contracts.termMonths,
      monthlyPaymentCents: contracts.monthlyPaymentCents,
      dueDay: contracts.dueDay,
      signedOn: contracts.signedOn,
      firstDueOn: contracts.firstDueOn,
      createdAt: contracts.createdAt,
      lotCode: lots.code,
      projectName: projects.name,
    })
    .from(contracts)
    .innerJoin(lots, eq(lots.id, contracts.lotId))
    .innerJoin(projects, eq(projects.id, lots.projectId))
    .where(inArray(contracts.id, contractIds))
    .all();

  return new Map(rows.map((row) => [row.id, row]));
}

type ContractDetail = {
  id: string;
  code: string;
  saleType: string;
  salePriceCents: number;
  downPaymentCents: number;
  termMonths: number | null;
  monthlyPaymentCents: number | null;
  dueDay: number | null;
  signedOn: string | null;
  firstDueOn: string | null;
  createdAt: string;
  lotCode: string;
  projectName: string;
};

function termsOf(detail: ContractDetail): ContractTerms {
  return {
    saleType: detail.saleType as SaleType,
    salePriceCents: detail.salePriceCents,
    downPaymentCents: detail.downPaymentCents,
    termMonths: detail.termMonths,
    monthlyPaymentCents: detail.monthlyPaymentCents,
    dueDay: detail.dueDay,
    signedOn: detail.signedOn ?? detail.createdAt.slice(0, 10),
    firstDueOn: detail.firstDueOn,
  };
}

/**
 * Turn a batch of receipt rows into what the API sends, with every figure
 * derived.
 *
 * Written as a batch rather than one receipt at a time so that the list screen
 * and the detail screen share exactly one implementation. Two code paths
 * computing "saldo anterior" is precisely how a receipt list ends up disagreeing
 * with the receipt it links to.
 */
function presentReceipts(db: Db, rows: readonly ReceiptRow[], includeLines: boolean) {
  if (rows.length === 0) {
    return [];
  }

  const receiptIds = rows.map((row) => row.id);
  const customerIds = [...new Set(rows.map((row) => row.customerId))];

  const allCredits = creditsForCustomers(db, customerIds);

  const creditsByCustomer = new Map<string, CustomerCredit[]>();
  const paymentsByReceipt = new Map<string, CustomerCredit[]>();

  for (const credit of allCredits) {
    const forCustomer = creditsByCustomer.get(credit.customerId);
    if (forCustomer) {
      forCustomer.push(credit);
    } else {
      creditsByCustomer.set(credit.customerId, [credit]);
    }

    if (credit.receiptId && receiptIds.includes(credit.receiptId)) {
      const forReceipt = paymentsByReceipt.get(credit.receiptId);
      if (forReceipt) {
        forReceipt.push(credit);
      } else {
        paymentsByReceipt.set(credit.receiptId, [credit]);
      }
    }
  }

  // One query for every attachment across the batch, grouped in memory — the
  // same shape as the credits above, and for the same reason.
  const attachmentsByReceipt = new Map<string, AttachmentRow[]>();

  if (includeLines) {
    for (const row of db
      .select({
        id: attachments.id,
        receiptId: attachments.receiptId,
        fileName: attachments.fileName,
        contentType: attachments.contentType,
        byteSize: attachments.byteSize,
        createdAt: attachments.createdAt,
      })
      .from(attachments)
      .where(inArray(attachments.receiptId, receiptIds))
      .all()) {
      const list = attachmentsByReceipt.get(row.receiptId);

      if (list) {
        list.push(row);
      } else {
        attachmentsByReceipt.set(row.receiptId, [row]);
      }
    }
  }

  const touchedContractIds = [
    ...new Set([...paymentsByReceipt.values()].flat().map((credit) => credit.contractId)),
  ];
  const details = includeLines
    ? contractDetailsFor(db, touchedContractIds)
    : new Map<string, ContractDetail>();
  const salePriceByContract = salePricesFor(
    db,
    [...new Set(allCredits.map((credit) => credit.contractId))],
  );

  return rows.map((row) => {
    const own = orderLedger(paymentsByReceipt.get(row.id) ?? []);
    const figures = receiptFigures({
      paymentIds: own.map((credit) => credit.id),
      customerCredits: creditsByCustomer.get(row.customerId) ?? [],
      salePriceByContract,
    });

    // A voided receipt's payments are reversed, so the ledger no longer counts
    // them and `figures` is all zeros. The amount that WAS on the document is
    // still what the document said, so it is reported from the rows themselves.
    const facePaidCents = own.reduce((total, credit) => total + credit.amountCents, 0);

    return {
      id: row.id,
      number: row.number,
      code: row.code,
      lookupCode: row.lookupCode,
      issuedOn: row.issuedOn,
      note: row.note,
      voidedAt: row.voidedAt,
      voidReason: row.voidReason,
      supersededById: row.supersededById,
      customer: {
        id: row.customerId,
        fullName: row.customerName,
        identification: row.customerIdentification,
        phone: row.customerPhone,
      },
      issuedBy: { id: row.issuedById, name: row.issuedByName },
      /** What the customer handed over. Unaffected by a later void. */
      totalPaid: facePaidCents,
      /** Every figure below is derived on read. None of them is a column. */
      previousBalance: figures.previousBalanceCents,
      newBalance: figures.newBalanceCents,
      cumulativePaid: figures.cumulativePaidCents,
      transactionCount: own.length,
      method: own[0]?.method ?? null,
      ...(includeLines
        ? {
            /** The customer's proof of transfer, when one was attached. */
            attachments: (attachmentsByReceipt.get(row.id) ?? []).map((file) => ({
              id: file.id,
              fileName: file.fileName,
              contentType: file.contentType,
              byteSize: file.byteSize,
              createdAt: file.createdAt,
            })),
            lines: own.map((credit) => {
              const line = figures.lines.find((entry) => entry.paymentId === credit.id);
              const detail = details.get(credit.contractId);

              return {
                paymentId: credit.id,
                contractId: credit.contractId,
                contractCode: detail?.code ?? null,
                lotCode: detail?.lotCode ?? null,
                projectName: detail?.projectName ?? null,
                amount: credit.amountCents,
                type: credit.type,
                /**
                 * The sale price this lot was contracted at — "Valor Total del
                 * Contrato" on the printed receipt.
                 *
                 * Sent per line rather than as one figure on the receipt
                 * because a receipt can cover several lots at several prices,
                 * and the document sums them itself. A single pre-summed total
                 * would be the one number on the page that could not be
                 * checked against the lines above it.
                 */
                contractTotal: detail?.salePriceCents ?? 0,
                previousBalance: line?.balanceBeforeCents ?? 0,
                newBalance: line?.balanceAfterCents ?? 0,
                /**
                 * Which cuotas this money went towards. The single most useful
                 * line on the document — "recibí L 5,000" is a number, "cuota 7
                 * de 24" is an answer.
                 */
                /**
                 * How many cuotas the contract has in total, so the receipt can
                 * say "cuota 7 de 24" rather than "cuota 7". The number on its
                 * own tells a customer where they are without telling them how
                 * far they have to go. Zero for a cash sale, which has none.
                 */
                installmentCount: detail ? buildSchedule(termsOf(detail)).length : 0,
                appliedTo:
                  detail && line
                    ? appliedInstallments(
                        termsOf(detail),
                        detail.salePriceCents - line.balanceBeforeCents,
                        detail.salePriceCents - line.balanceAfterCents,
                      )
                    : [],
              };
            }),
          }
        : {}),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

const receiptBody = z.object({
  customerId: z.string().min(1),
  /** The day the money moved. Back-dating is allowed and is the point. */
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Usa una fecha AAAA-MM-DD."),
  method: z.enum(PAYMENT_METHODS),
  /** The bank's confirmation number, for a transfer. */
  reference: z.string().trim().max(120).nullish(),
  note: z.string().trim().max(500).nullish(),
  /**
   * What the customer actually handed over, when it was not lempiras.
   *
   * The lines below are always in lempira centavos, because that is what the
   * contracts are denominated in and what the balance is built from. This pair
   * records the other side of the counter so the receipt can say "$500 al tipo
   * de cambio 26.50" instead of silently reporting a converted figure the
   * customer never saw.
   */
  originalCurrency: z.enum(["HNL", "USD"]).default("HNL"),
  exchangeRate: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "El tipo de cambio debe ser un número.")
    .default("1"),
  /**
   * The client's own key for this submission. A second arrival of the same key
   * returns the receipt the first one created rather than taking the money
   * twice — see `receipts.idempotency_key`.
   */
  idempotencyKey: z.string().trim().min(8).max(80).nullish(),
  /**
   * Deliberate acknowledgement that a line exceeds what its contract still
   * owes. Off by default: a typed extra zero must not become a silent credit
   * nobody can explain.
   */
  allowOverpayment: z.boolean().default(false),
  lines: z
    .array(
      z.object({
        contractId: z.string().min(1),
        amountCents: z.number().int().positive(),
        type: z.enum(PAYMENT_TYPES),
        notes: z.string().trim().max(300).nullish(),
      }),
    )
    .min(1, "Un recibo necesita al menos una transacción."),
});

const voidBody = z.object({
  reason: z.string().trim().min(10).max(500),
});

/**
 * Split the ORIGINAL amount across the lines so the parts sum to the whole.
 *
 * Only relevant to a payment made in dollars. Converting each line
 * independently would leave the dollar figures summing to a cent more or less
 * than the amount the customer actually handed over, and a receipt whose column
 * does not add up is worth nothing. So every line but the last is converted and
 * rounded, and the last absorbs the difference — the same rule the last
 * installment follows in src/lib/contracts.ts.
 */
function originalAmounts(
  lineAmountsCents: readonly number[],
  totalCents: number,
  rate: number,
): number[] {
  if (rate === 1) {
    return [...lineAmountsCents];
  }

  const totalOriginal = Math.round(totalCents / rate);
  const amounts = lineAmountsCents.map((amount) => Math.round(amount / rate));
  const drift = totalOriginal - amounts.reduce((sum, amount) => sum + amount, 0);

  if (amounts.length > 0) {
    amounts[amounts.length - 1] = amounts[amounts.length - 1]! + drift;
  }

  return amounts;
}

export interface ReceiptRoutesOptions {
  /** Where uploaded proof-of-payment files are written. See config/env.ts. */
  uploadsPath: string;
}

export const receiptRoutes: FastifyPluginAsync<ReceiptRoutesOptions> = async (app, options) => {
  // Registered inside this plugin rather than app-wide, so the only routes that
  // can accept a file upload are the ones below. The limits are the real guard:
  // Fastify itself will refuse a body past `fileSize` before it reaches a
  // handler, so a hostile 4 GB upload is rejected while streaming rather than
  // after it has filled the disk.
  await app.register(multipart, {
    limits: {
      fileSize: MAX_ATTACHMENT_BYTES,
      files: 1,
      fields: 4,
    },
  });

  /* ---------------------------------------------------------------------- */
  /* Reading                                                                 */
  /* ---------------------------------------------------------------------- */

  app.get("/receipts", { onRequest: app.requireUser }, async () => {
    const rows = receiptsListQuery(app.db).orderBy(desc(receipts.number)).all();

    return { receipts: presentReceipts(app.db, rows, false) };
  });

  /**
   * Find a receipt by its short lookup code.
   *
   * Separate from `/receipts/:id` because this is the code a customer reads off
   * a printed document or a WhatsApp message, and it must not be confused with
   * the sequential number — see src/lib/receipts.ts for why there are two.
   */
  app.get<{ Params: { code: string } }>(
    "/receipts/lookup/:code",
    { onRequest: app.requireUser },
    async (request, reply) => {
      const stored = toStoredLookupCode(request.params.code);

      if (stored === null) {
        return reply.code(400).send({
          error: "invalid_lookup_code",
          message: "Ese código no tiene la forma de un código de recibo.",
        });
      }

      const row = receiptsListQuery(app.db).where(eq(receipts.lookupCode, stored)).get();

      if (!row) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "No existe un recibo con ese código." });
      }

      return { receipt: presentReceipts(app.db, [row], true)[0] };
    },
  );

  /**
   * Has this payment already been recorded?
   *
   * Answered BEFORE the receipt is issued, so the person at the keyboard can
   * decide, rather than after — a duplicate payment is not something an error
   * message can undo. It is reported, never enforced: a customer paying the
   * same amount twice in a day is unusual but entirely legal, and a check that
   * blocked it would be wrong more often than the mistake it prevents.
   *
   * A DUPLICATE IS A RECEIPT, NOT A PAYMENT, and that distinction is the whole
   * reason this is not a one-line query. One receipt carries one reference and
   * splits across as many lines as the customer has lots — so L 30,000 across
   * three lots is three payments of L 10,000, same customer, same date, same
   * reference. Compared payment by payment, every multi-lot receipt in the
   * database would report itself as three duplicates of itself.
   *
   * Two questions, because real comprobantes fall into two kinds:
   *
   *  - BY REFERENCE, the strong signal. The bank's confirmation number is
   *    unique to a transaction, so a second one carrying it is the same money
   *    arriving twice. This is the one worth trusting.
   *  - BY CUSTOMER, DATE AND TOTAL, for the confirmations that carry no
   *    reference at all — a BAC agent slip names no depositor, and a remittance
   *    app's "Envío confirmado" screenshot has no number, no date and no payer.
   *    Weaker and noisier, but it is the shape that actually caused trouble:
   *    two payments of L 7,000.00 to the same account on 2026-08-29, hours
   *    apart, which nothing about the amount or the day can tell apart.
   *
   * A receipt already reversed or voided is still reported. "You entered this
   * and then cancelled it" is exactly what somebody about to enter it again
   * needs to know, and hiding it would make the second entry look novel.
   *
   * No index on `payments.reference` yet, deliberately. A reference match is a
   * table scan, which on a few thousand payments SQLite does in well under a
   * millisecond; add `index("payments_reference_idx")` when this database holds
   * tens of thousands of rows, not before.
   */
  app.get<{
    Querystring: {
      reference?: string;
      customerId?: string;
      paidOn?: string;
      amountCents?: string;
    };
  }>("/receipts/duplicates", { onRequest: app.requireUser }, async (request) => {
    const reference = (request.query.reference ?? "").trim();
    const customerId = (request.query.customerId ?? "").trim();
    const paidOn = (request.query.paidOn ?? "").trim();
    const amountCents = Number(request.query.amountCents);

    const wantsAmountCheck =
      customerId !== "" &&
      /^\d{4}-\d{2}-\d{2}$/.test(paidOn) &&
      Number.isInteger(amountCents) &&
      amountCents > 0;

    if (reference === "" && !wantsAmountCheck) {
      return { matches: [] };
    }

    /** Every payment that could belong to a match, with its context. */
    const candidates = (where: ReturnType<typeof eq> | ReturnType<typeof and>) =>
      app.db
        .select({
          paymentId: payments.id,
          receiptId: payments.receiptId,
          amountCents: payments.amountCents,
          paidOn: payments.paidOn,
          reference: payments.reference,
          reversedAt: payments.reversedAt,
          receiptCode: receipts.code,
          receiptVoidedAt: receipts.voidedAt,
          customerName: customers.fullName,
          lotCode: lots.code,
        })
        .from(payments)
        .innerJoin(contracts, eq(contracts.id, payments.contractId))
        .innerJoin(lots, eq(lots.id, contracts.lotId))
        .innerJoin(customers, eq(customers.id, contracts.customerId))
        .leftJoin(receipts, eq(receipts.id, payments.receiptId))
        .where(where)
        .all();

    type Row = ReturnType<typeof candidates>[number];

    /**
     * Fold payments into the receipts they belong to.
     *
     * Keyed by receipt, falling back to the payment's own id for the payments
     * that have none — money recorded without issuing a document is real and
     * counts in every balance, so it must be able to report a duplicate too.
     */
    const fold = (rows: Row[], reason: "reference" | "amount") => {
      const grouped = new Map<
        string,
        {
          reason: "reference" | "amount";
          receiptId: string | null;
          receiptCode: string | null;
          paidOn: string;
          amountCents: number;
          reference: string | null;
          customerName: string;
          lotCodes: string[];
          /** Voided as a document, or every one of its payments reversed. */
          cancelled: boolean;
        }
      >();

      for (const row of rows) {
        const key = row.receiptId ?? `payment:${row.paymentId}`;
        const existing = grouped.get(key);

        // Reversed money is excluded from the total but not from the report:
        // the receipt still shows up, marked cancelled.
        const live = row.reversedAt === null ? row.amountCents : 0;

        if (!existing) {
          grouped.set(key, {
            reason,
            receiptId: row.receiptId,
            receiptCode: row.receiptCode,
            paidOn: row.paidOn,
            amountCents: live,
            reference: row.reference,
            customerName: row.customerName,
            lotCodes: [row.lotCode],
            cancelled: row.receiptVoidedAt !== null || row.reversedAt !== null,
          });

          continue;
        }

        existing.amountCents += live;
        existing.lotCodes.push(row.lotCode);
        // Cancelled only when EVERY line is: a receipt with one reversed line
        // out of three is still a live receipt.
        existing.cancelled = existing.cancelled && (row.reversedAt !== null);
      }

      return [...grouped.values()];
    };

    const byReference =
      reference === ""
        ? []
        : fold(
            candidates(sql`lower(trim(${payments.reference})) = lower(trim(${reference}))`),
            "reference",
          );

    let byAmount: ReturnType<typeof fold> = [];

    if (wantsAmountCheck) {
      // Narrow in SQL to one customer on one day, then compare receipt TOTALS
      // in memory. The comparison cannot be pushed into the WHERE clause: the
      // figure being matched is a sum across a receipt's lines, not a column.
      const sameDay = fold(
        candidates(and(eq(contracts.customerId, customerId), eq(payments.paidOn, paidOn))!),
        "amount",
      );

      byAmount = sameDay.filter((match) => match.amountCents === amountCents);
    }

    // A receipt matching on both is one finding, reported under the stronger
    // reason. Listing it twice would read as two separate prior payments.
    const seen = new Set(byReference.map((match) => match.receiptId ?? match.receiptCode));

    return {
      matches: [
        ...byReference,
        ...byAmount.filter((match) => !seen.has(match.receiptId ?? match.receiptCode)),
      ],
    };
  });

  app.get<{ Params: { id: string } }>(
    "/receipts/:id",
    { onRequest: app.requireUser },
    async (request, reply) => {
      const row = receiptsListQuery(app.db).where(eq(receipts.id, request.params.id)).get();

      if (!row) {
        return reply.code(404).send({ error: "not_found", message: "Ese recibo no existe." });
      }

      return { receipt: presentReceipts(app.db, [row], true)[0] };
    },
  );

  /* ---------------------------------------------------------------------- */
  /* Issuing                                                                 */
  /* ---------------------------------------------------------------------- */

  app.post(
    "/receipts",
    { onRequest: app.requireCapability("payment:record") },
    async (request, reply) => {
      const parsed = receiptBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_receipt",
          message: parsed.error.issues[0]?.message ?? "Revisa los datos del recibo.",
        });
      }

      const body = parsed.data;
      const actor = request.user!;

      // An idempotent repeat is answered with the original receipt, before any
      // validation runs: the second tap must be a no-op even if the contract
      // has since been paid off by the first one.
      if (body.idempotencyKey) {
        const existing = receiptsListQuery(app.db)
          .where(eq(receipts.idempotencyKey, body.idempotencyKey))
          .get();

        if (existing) {
          return reply
            .code(200)
            .send({ receipt: presentReceipts(app.db, [existing], true)[0], duplicate: true });
        }
      }

      const customer = app.db
        .select({ id: customers.id, fullName: customers.fullName })
        .from(customers)
        .where(eq(customers.id, body.customerId))
        .get();

      if (!customer) {
        return reply
          .code(404)
          .send({ error: "customer_not_found", message: "Ese cliente no existe." });
      }

      const rate = Number(body.exchangeRate);

      if (!Number.isFinite(rate) || rate <= 0) {
        return reply.code(400).send({
          error: "invalid_rate",
          message: "El tipo de cambio debe ser mayor que cero.",
        });
      }

      if (body.originalCurrency === "HNL" && rate !== 1) {
        return reply.code(400).send({
          error: "invalid_rate",
          message: "Un pago en lempiras no lleva tipo de cambio.",
        });
      }

      // One contract may not appear twice: two lines against the same lot are
      // one line, and allowing both makes the overpayment check below wrong.
      const seen = new Set<string>();

      for (const line of body.lines) {
        if (seen.has(line.contractId)) {
          return reply.code(400).send({
            error: "duplicate_contract",
            message: "Un contrato solo puede aparecer una vez en el mismo recibo.",
          });
        }
        seen.add(line.contractId);
      }

      const contractRows = app.db
        .select({
          id: contracts.id,
          code: contracts.code,
          customerId: contracts.customerId,
          status: contracts.status,
          salePriceCents: contracts.salePriceCents,
        })
        .from(contracts)
        .where(inArray(contracts.id, [...seen]))
        .all();

      const byId = new Map(contractRows.map((row) => [row.id, row]));

      for (const line of body.lines) {
        const contract = byId.get(line.contractId);

        if (!contract) {
          return reply
            .code(404)
            .send({ error: "contract_not_found", message: "Uno de los contratos no existe." });
        }

        // The receipt names one customer, so every line has to be that person's
        // money. Without this a payment could be filed against a stranger's lot
        // and the customer's cumulative total would quietly include it.
        if (contract.customerId !== body.customerId) {
          return reply.code(400).send({
            error: "contract_not_customers",
            message: `El contrato ${contract.code} no pertenece a ${customer.fullName}.`,
          });
        }

        if (contract.status === "cancelled" || contract.status === "defaulted") {
          return reply.code(409).send({
            error: "contract_closed",
            message: `El contrato ${contract.code} está cerrado y no admite pagos.`,
          });
        }

        if (!body.allowOverpayment) {
          const balance = contractBalanceCents(app.db, contract.id, contract.salePriceCents);

          if (line.amountCents > balance) {
            return reply.code(409).send({
              error: "overpayment",
              message:
                `El contrato ${contract.code} solo debe L ${(balance / 100).toLocaleString("es-HN")}. ` +
                "Confirma el sobrepago si el cliente realmente entregó de más.",
              balanceCents: balance,
              contractId: contract.id,
            });
          }
        }
      }

      const totalCents = body.lines.reduce((total, line) => total + line.amountCents, 0);
      const originals = originalAmounts(
        body.lines.map((line) => line.amountCents),
        totalCents,
        rate,
      );

      const receiptId = randomUUID();
      // Written explicitly rather than left to the column default, so the
      // ledger can order same-day transactions by millisecond instead of by
      // SQLite's whole seconds. See `compareLedgerOrder`.
      const now = new Date().toISOString();

      try {
        app.db.transaction((tx) => {
          // Allocated inside the transaction, which holds the write lock, so
          // two receipts issued at the same moment cannot take one number. The
          // unique index is the backstop if this is ever got wrong.
          const highest = tx
            .select({ value: sql<number | null>`MAX(${receipts.number})` })
            .from(receipts)
            .get();

          const number = nextReceiptNumber(highest?.value);

          // The printed code is random and independent of `number`, so unlike
          // the sequence it can collide. Checked here, inside the transaction
          // that holds the write lock, so nothing can take the code between
          // the check and the insert.
          const code = allocateReceiptCode((candidate) => {
            const clash = tx
              .select({ id: receipts.id })
              .from(receipts)
              .where(eq(receipts.code, candidate))
              .get();

            return clash !== undefined;
          });

          tx.insert(receipts)
            .values({
              id: receiptId,
              number,
              code,
              lookupCode: generateLookupCode(),
              customerId: body.customerId,
              issuedOn: body.paidOn,
              issuedBy: actor.id,
              idempotencyKey: body.idempotencyKey ?? null,
              note: body.note ?? null,
              createdAt: now,
            })
            .run();

          body.lines.forEach((line, index) => {
            tx.insert(payments)
              .values({
                id: randomUUID(),
                contractId: line.contractId,
                receiptId,
                amountCents: line.amountCents,
                originalAmountCents: originals[index]!,
                originalCurrency: body.originalCurrency,
                exchangeRate: body.exchangeRate,
                paidOn: body.paidOn,
                method: body.method,
                reference: body.reference ?? null,
                type: line.type,
                notes: line.notes ?? null,
                recordedBy: actor.id,
                createdAt: now,
              })
              .run();
          });

          recordAudit(tx, {
            actorId: actor.id,
            entityType: "payment",
            entityId: receiptId,
            action: "create",
            after: {
              receiptNumber: number,
              receiptCode: code,
              customerId: body.customerId,
              paidOn: body.paidOn,
              method: body.method,
              totalCents,
              lines: body.lines,
            },
          });

          // A payment that clears a contract's balance settles it — active
          // becomes paid_off, once, here.
          for (const contractId of seen) {
            syncContractLifecycle(tx, contractId, actor.id);
          }
        });
      } catch (error) {
        // The unique index on `idempotency_key` is the last word on a double
        // submission: two identical requests racing each other both pass the
        // lookup above, and the loser lands here rather than taking the money
        // twice.
        if (body.idempotencyKey && String(error).includes("UNIQUE")) {
          const existing = receiptsListQuery(app.db)
            .where(eq(receipts.idempotencyKey, body.idempotencyKey))
            .get();

          if (existing) {
            return reply
              .code(200)
              .send({ receipt: presentReceipts(app.db, [existing], true)[0], duplicate: true });
          }
        }

        throw error;
      }

      const row = receiptsListQuery(app.db).where(eq(receipts.id, receiptId)).get()!;

      return reply.code(201).send({ receipt: presentReceipts(app.db, [row], true)[0] });
    },
  );

  /* ---------------------------------------------------------------------- */
  /* Voiding                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Void a receipt and reverse the money it carried.
   *
   * Nothing is deleted and the number is never reused. A missing receipt number
   * cannot be told apart from a hidden one, so a void has to stay visible AS a
   * void — which is also what lets the customer holding the old paper be shown
   * why it no longer stands.
   */
  app.post<{ Params: { id: string } }>(
    "/receipts/:id/void",
    { onRequest: app.requireCapability("payment:reverse") },
    async (request, reply) => {
      const parsed = voidBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "reason_required",
          message: "Explica por qué se anula el recibo (al menos 10 caracteres).",
        });
      }

      const existing = app.db
        .select()
        .from(receipts)
        .where(eq(receipts.id, request.params.id))
        .get();

      if (!existing) {
        return reply.code(404).send({ error: "not_found", message: "Ese recibo no existe." });
      }

      if (existing.voidedAt) {
        return reply
          .code(409)
          .send({ error: "already_voided", message: "Ese recibo ya está anulado." });
      }

      const actor = request.user!;
      const now = new Date().toISOString();

      const affected = app.db
        .select({
          id: payments.id,
          amountCents: payments.amountCents,
          contractId: payments.contractId,
        })
        .from(payments)
        .where(and(eq(payments.receiptId, existing.id), sql`${payments.reversedAt} IS NULL`))
        .all();

      app.db.transaction((tx) => {
        tx.update(receipts)
          .set({
            voidedAt: now,
            voidReason: parsed.data.reason,
            voidedBy: actor.id,
          })
          .where(eq(receipts.id, existing.id))
          .run();

        // The payments keep their amount, their date and their rate. They
        // simply stop counting — every balance in the app already filters on
        // `reversed_at IS NULL`, so this is all it takes for the whole ledger,
        // and every receipt issued after this one, to re-derive.
        tx.update(payments)
          .set({ reversedAt: now, reversedBy: actor.id, reversalReason: parsed.data.reason })
          .where(and(eq(payments.receiptId, existing.id), sql`${payments.reversedAt} IS NULL`))
          .run();

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "payment",
          entityId: existing.id,
          action: "reverse",
          reason: parsed.data.reason,
          before: {
            receiptNumber: existing.number,
            reversedPayments: affected.map((payment) => payment.id),
            totalCents: affected.reduce((total, payment) => total + payment.amountCents, 0),
          },
        });

        // Reversing these payments can push a paid-off contract's balance back
        // above zero — it returns to active.
        for (const contractId of new Set(affected.map((payment) => payment.contractId))) {
          syncContractLifecycle(tx, contractId, actor.id);
        }
      });

      const row = receiptsListQuery(app.db).where(eq(receipts.id, existing.id)).get()!;

      return { receipt: presentReceipts(app.db, [row], true)[0] };
    },
  );

  /* ---------------------------------------------------------------------- */
  /* Proof of payment                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Attach the customer's proof of transfer to a receipt.
   *
   * The file the customer sent on WhatsApp, kept beside the payment it belongs
   * to. Six months later, when the payment is disputed, the phone has been
   * replaced and the chat is gone — this is the copy that is still there.
   *
   * The bytes are written to disk under a generated name and the row records
   * where they went; nothing the uploader chose ever reaches the filesystem.
   * See src/lib/attachments.ts.
   */
  app.post<{ Params: { id: string } }>(
    "/receipts/:id/attachments",
    { onRequest: app.requireCapability("payment:record") },
    async (request, reply) => {
      const receipt = app.db
        .select({ id: receipts.id, code: receipts.code })
        .from(receipts)
        .where(eq(receipts.id, request.params.id))
        .get();

      if (!receipt) {
        return reply.code(404).send({ error: "not_found", message: "Ese recibo no existe." });
      }

      const existing = app.db
        .select({ value: sql<number>`COUNT(*)` })
        .from(attachments)
        .where(eq(attachments.receiptId, receipt.id))
        .get();

      if ((existing?.value ?? 0) >= MAX_ATTACHMENTS_PER_RECEIPT) {
        return reply.code(409).send({
          error: "too_many_attachments",
          message: `Un recibo admite hasta ${MAX_ATTACHMENTS_PER_RECEIPT} comprobantes.`,
        });
      }

      let part;

      try {
        part = await request.file();
      } catch {
        // Thrown by @fastify/multipart when the body is not multipart at all.
        return reply
          .code(400)
          .send({ error: "invalid_upload", message: "No se recibió ningún archivo." });
      }

      if (!part) {
        return reply
          .code(400)
          .send({ error: "invalid_upload", message: "No se recibió ningún archivo." });
      }

      if (!isAllowedContentType(part.mimetype)) {
        return reply.code(415).send({
          error: "unsupported_type",
          message: "Solo se aceptan imágenes (JPG, PNG, WEBP, HEIC) o un PDF.",
        });
      }

      const buffer = await part.toBuffer();

      // `toBuffer` resolves even when the stream was truncated at the limit, so
      // the flag has to be asked about explicitly. Without this a 20 MB photo
      // would be stored silently as its first 12 MB — a corrupt file that looks
      // like a successful upload.
      if (part.file.truncated) {
        return reply.code(413).send({
          error: "file_too_large",
          message: `El archivo supera el máximo de ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB.`,
        });
      }

      if (buffer.byteLength === 0) {
        return reply
          .code(400)
          .send({ error: "empty_file", message: "El archivo está vacío." });
      }

      const storageKey = storageKeyFor(part.mimetype);
      const attachmentId = randomUUID();

      await mkdir(options.uploadsPath, { recursive: true });
      await writeFile(join(options.uploadsPath, storageKey), buffer);

      try {
        app.db.transaction((tx) => {
          tx.insert(attachments)
            .values({
              id: attachmentId,
              receiptId: receipt.id,
              storageKey,
              fileName: safeDisplayName(part.filename ?? "comprobante"),
              contentType: part.mimetype,
              byteSize: buffer.byteLength,
              uploadedBy: request.user!.id,
            })
            .run();

          recordAudit(tx, {
            actorId: request.user!.id,
            entityType: "payment",
            entityId: receipt.id,
            action: "update",
            after: { attachedFile: safeDisplayName(part.filename ?? "comprobante"), receiptCode: receipt.code },
          });
        });
      } catch (error) {
        // The row is what makes the file findable. If it could not be written,
        // the bytes on disk are unreachable rubbish, so they go too rather than
        // accumulating as orphans nobody will ever notice.
        await unlink(join(options.uploadsPath, storageKey)).catch(() => undefined);
        throw error;
      }

      return reply.code(201).send({
        attachment: {
          id: attachmentId,
          fileName: safeDisplayName(part.filename ?? "comprobante"),
          contentType: part.mimetype,
          byteSize: buffer.byteLength,
        },
      });
    },
  );

  /**
   * Serve one attached file.
   *
   * Behind the session guard like everything else: a proof of payment carries a
   * customer's name, their bank and their account, and is nobody else's
   * business. The id is a UUID rather than a guessable number for the same
   * reason the receipt lookup code is random.
   */
  app.get<{ Params: { id: string } }>(
    "/attachments/:id/file",
    { onRequest: app.requireUser },
    async (request, reply) => {
      const row = app.db
        .select()
        .from(attachments)
        .where(eq(attachments.id, request.params.id))
        .get();

      if (!row) {
        return reply.code(404).send({ error: "not_found", message: "Ese archivo no existe." });
      }

      // Asserted on the way out as well as on the way in. The key comes from
      // our own row, so this can only fail if something has already gone very
      // wrong — which is exactly when a path handed to the filesystem must not
      // be trusted.
      if (!isValidStorageKey(row.storageKey)) {
        request.log.error({ attachmentId: row.id }, "Refusing to serve a malformed storage key");
        return reply.code(500).send({ error: "bad_storage_key", message: "Archivo no disponible." });
      }

      // `Content-Disposition: attachment` rather than inline: a stored PDF or
      // SVG rendered in the browser would run in this app's origin, and a
      // proof of payment is a file somebody else chose the contents of.
      reply
        .header("Content-Type", row.contentType)
        .header("Content-Length", String(row.byteSize))
        .header("Content-Disposition", `attachment; filename="${encodeURIComponent(row.fileName)}"`)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "private, max-age=3600");

      return reply.send(createReadStream(join(options.uploadsPath, row.storageKey)));
    },
  );

  /**
   * Remove an attachment.
   *
   * The row and the file both go: unlike money, a wrongly-attached photo has no
   * history worth preserving, and leaving somebody else's bank details on the
   * wrong customer's receipt is the failure to avoid here.
   */
  app.delete<{ Params: { id: string } }>(
    "/attachments/:id",
    { onRequest: app.requireCapability("payment:record") },
    async (request, reply) => {
      const row = app.db
        .select()
        .from(attachments)
        .where(eq(attachments.id, request.params.id))
        .get();

      if (!row) {
        return reply.code(404).send({ error: "not_found", message: "Ese archivo no existe." });
      }

      app.db.transaction((tx) => {
        tx.delete(attachments).where(eq(attachments.id, row.id)).run();

        recordAudit(tx, {
          actorId: request.user!.id,
          entityType: "payment",
          entityId: row.receiptId,
          action: "update",
          before: { removedFile: row.fileName },
        });
      });

      // After the row, and forgiving: a file already gone from disk must not
      // stop the row being removed, or the attachment becomes undeletable.
      if (isValidStorageKey(row.storageKey)) {
        await unlink(join(options.uploadsPath, row.storageKey)).catch(() => undefined);
      }

      return { ok: true };
    },
  );
};
