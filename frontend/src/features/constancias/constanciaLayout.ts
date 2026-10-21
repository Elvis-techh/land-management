import type { Cents } from "../../lib/money";
import { cents } from "../../lib/money";
import { paymentTypeLabel } from "../receipts/paymentType";
import type { ConstanciaPart } from "./api";

type Payment = ConstanciaPart["payments"][number];

/** One line of the letter's summary: every payment of one kind, together. */
export interface PaymentSummaryLine {
  label: string;
  count: number;
  firstOn: string;
  lastOn: string;
  total: Cents;
}

/**
 * The payments grouped by kind, for the letter itself: «Prima · 1 pago»,
 * «Cuota · 58 pagos, del 15/02/2021 al 15/12/2025», with the amount of each.
 *
 * The letter has to fit one page whatever the history, and a contract of 60
 * cuotas has 60 lines of history. What a notary reads on the first page is
 * that the money arrived and how; the line-by-line detail is in the annex.
 * Kinds are listed in the order they were first paid, so the prima comes first.
 */
export function summarizePayments(payments: readonly Payment[]): PaymentSummaryLine[] {
  const lines = new Map<string, PaymentSummaryLine>();

  for (const payment of payments) {
    const line = lines.get(payment.type);

    if (line) {
      line.count += 1;
      line.lastOn = payment.paidOn;
      line.total = cents(line.total + payment.amount);
    } else {
      lines.set(payment.type, {
        label: paymentTypeLabel(payment.type),
        count: 1,
        firstOn: payment.paidOn,
        lastOn: payment.paidOn,
        total: payment.amount,
      });
    }
  }

  return [...lines.values()];
}

/**
 * How many payment lines one annex sheet holds.
 *
 * MEASURED, like the receipt's print constants: printed to PDF in Chrome at the
 * document's 10pt base, 36 rows were the most that still came back as one A4
 * page per sheet. 32 leaves about the same reserve the receipt keeps, for the
 * print dialog's own margins and for Letter paper. Re-measure rather than
 * adjust if the annex's spacing changes. A 60-cuota contract is two sheets.
 */
export const ANNEX_ROWS_PER_PAGE = 32;

/** The history cut into annex sheets, in order. Empty when there is nothing to list. */
export function annexPages<T>(payments: readonly T[]): T[][] {
  const pages: T[][] = [];

  for (let start = 0; start < payments.length; start += ANNEX_ROWS_PER_PAGE) {
    pages.push(payments.slice(start, start + ANNEX_ROWS_PER_PAGE));
  }

  return pages;
}

/** One line of the annex: a payment, and which lot it was for. */
export type AnnexRow = Payment & { lotCode: string };

/**
 * Every payment of every lot on the constancia, lot by lot and in date order
 * within each, for the annex. A combined constancia's annex reads as one
 * ledger with a Lote column, rather than restarting per lot.
 */
export function annexRows(parts: readonly ConstanciaPart[]): AnnexRow[] {
  return parts.flatMap((part) => part.payments.map((payment) => ({ ...payment, lotCode: part.lot.code })));
}

/** "B-12", "B-12 y B-13", "B-12, B-13 y C-02". */
export function joinSpanish(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
}

/**
 * The lots as the letter names them: «Lotes B-12 y B-13 del Proyecto Santiago»
 * when they share a project, «Lote B-12 del Proyecto Santiago y Lote C-02 de
 * Valle Verde» when they do not.
 */
export function lotsPhrase(parts: readonly ConstanciaPart[]): string {
  const projects = [...new Set(parts.map((part) => part.lot.projectName))];

  if (projects.length === 1) {
    const codes = parts.map((part) => part.lot.code);

    return `${codes.length === 1 ? "Lote" : "Lotes"} ${joinSpanish(codes)} del ${projects[0]}`;
  }

  return joinSpanish(parts.map((part) => `Lote ${part.lot.code} del ${part.lot.projectName}`));
}
