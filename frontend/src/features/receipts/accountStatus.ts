import type { Cents, MoneyView } from "../../lib/money";
import { formatDocumentMoney } from "../../lib/money";
import type { ReceiptLine } from "../../types";

/*
 * «Estado de su cuenta»: the box on the receipt that answers what a customer
 * asks after paying — what is next, how far along am I, and am I up to date.
 *
 *   PRÓXIMA CUOTA        CUOTAS PAGADAS      ESTADO
 *   5 nov 2026           4 de 12             [Al día]
 *   Cuota 5 · L. 25,000  ▮▮▮▯▯▯▯▯▯▯▯▯        Sin cuotas pendientes
 *
 * Every figure is the server's, measured at the receipt's own date and place
 * in the ledger (see `standingAfter` in routes/receipts.ts), so a receipt
 * printed again next year still says what was true the day it was issued.
 * The words for "behind" and "ahead" are the contract health's own rules: the
 * five days' grace, and a late prima named as such rather than as months.
 */

export type StatusTone = "ok" | "ahead" | "late" | "paid";

export interface AccountStatus {
  paymentId: string;
  /** "B-12": only shown when the receipt covers more than one lot. */
  lotCode: string | null;
  next: { value: string; note: string };
  paid: { label: string; before: number; today: number; total: number };
  status: { label: string; tone: StatusTone; note: string };
}

/** Always lempiras, like every figure a customer is handed on the document. */
const LEMPIRAS: MoneyView = { currency: "HNL", usdRate: 1 };

function money(amount: Cents): string {
  return formatDocumentMoney(amount, LEMPIRAS);
}

/** "5 nov 2026": short, because the box has three columns to share. */
export function shortDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const formatter = new Intl.DateTimeFormat("es-HN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

  // "5 nov. 2026" in some engines: the full stop is noise in a narrow column.
  return formatter.format(new Date(Date.UTC(year!, month! - 1, day!))).replace(".", "");
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function nextCell(line: ReceiptLine, issuedOn: string): AccountStatus["next"] {
  const next = line.nextDue;

  if (next === null) {
    return { value: "Ninguna", note: "No hay más cuotas" };
  }

  // Behind, the "next" cuota is the oldest unpaid one, and its date has gone
  // by: «5 ago 2026» on a receipt of 21 October must not read as upcoming.
  const overdue = next.dueOn < issuedOn ? "Vencida · " : "";

  if (next.isDownPayment) {
    return { value: shortDate(next.dueOn), note: `${overdue}Resto de la prima · ${money(next.amount)}` };
  }

  // This payment went part of the way into that very cuota: what is left of it.
  const startedToday = line.appliedTo.some(
    (installment) => installment.number === next.number && !installment.settled,
  );

  if (startedToday) {
    return {
      value: shortDate(next.dueOn),
      note: `${overdue}Resto de cuota ${next.number} · ${money(next.amount)}`,
    };
  }

  // An advance from earlier, often the centavos of a payment a little over the
  // cuota: the cuota as it stands, and what is already in.
  const credit = next.credit > 0 ? ` (ya abonó ${money(next.credit)})` : "";

  return {
    value: shortDate(next.dueOn),
    note: `${overdue}Cuota ${next.number} · ${money(next.amount)}${credit}`,
  };
}

function statusCell(line: ReceiptLine): AccountStatus["status"] {
  const standing = line.standing!;
  const next = line.nextDue;

  if (standing.settled) {
    return { label: "Pagado", tone: "paid", note: "Contrato pagado en su totalidad" };
  }

  if (standing.monthsBehind > 0 || standing.downPaymentLate) {
    const parts = [
      standing.downPaymentLate ? "Prima pendiente" : null,
      standing.monthsBehind > 0 ? plural(standing.monthsBehind, "cuota vencida", "cuotas vencidas") : null,
    ].filter(Boolean);

    return { label: "Atrasado", tone: "late", note: parts.join(" · ") };
  }

  if (standing.monthsAhead > 0) {
    return {
      label: `Adelantado ${plural(standing.monthsAhead, "cuota", "cuotas")}`,
      tone: "ahead",
      note: "Sin cuotas pendientes",
    };
  }

  // Up to date, with a cuota part-paid and not yet due: say when it is.
  if (next !== null && !next.isDownPayment && next.credit > 0) {
    return { label: "Al día", tone: "ok", note: `La cuota ${next.number} vence el ${shortDate(next.dueOn)}` };
  }

  return { label: "Al día", tone: "ok", note: "Sin cuotas pendientes" };
}

/**
 * The most lots the box has a row for.
 *
 * A receipt is one sheet of A4 (see `printBaseFor` in ReceiptPaper.tsx), and a
 * row here is taller than the lot's own line in the table. Three rows still fit
 * at a readable size; eight, the most a receipt fitted before the box, would
 * not. Past three the box is left out, and each lot's line in the table still
 * says what the money did to it.
 */
export const MAX_STATUS_ROWS = 3;

/**
 * One row per lot on the receipt that has cuotas. A cash sale has none to
 * count, and a receipt of nothing but cash sales has no box at all; nor does
 * one for more lots than `MAX_STATUS_ROWS`.
 */
export function accountStatus(lines: ReceiptLine[], issuedOn: string): AccountStatus[] {
  const financed = lines.filter((line) => line.standing !== null && line.installmentCount > 0);

  if (financed.length > MAX_STATUS_ROWS) {
    return [];
  }

  return financed.map((line) => {
    const standing = line.standing!;

    return {
      paymentId: line.paymentId,
      lotCode: lines.length > 1 ? line.lotCode : null,
      next: nextCell(line, issuedOn),
      paid: {
        label: `${standing.installmentsPaid} de ${line.installmentCount}`,
        before: standing.installmentsPaidBefore,
        today: standing.installmentsPaid - standing.installmentsPaidBefore,
        total: line.installmentCount,
      },
      status: statusCell(line),
    };
  });
}
