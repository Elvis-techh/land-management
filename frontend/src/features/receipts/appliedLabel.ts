import type { Cents, MoneyView } from "../../lib/money";
import { cents, formatDocumentMoney } from "../../lib/money";
import type { AppliedInstallment, MoraPaid, ReceiptLine } from "../../types";

/** Everything the label below reads. A whole `ReceiptLine` is more than it needs. */
export type AppliedLabelLine = Pick<ReceiptLine, "appliedTo" | "installmentCount" | "newBalance">;

/**
 * A cuota this payment touched with less than a tenth of the cuota is a sliver,
 * not a cuota the payment was FOR.
 *
 * Slivers are real and routine. `splitEvenly` hands the odd centavo of an
 * uneven division to one contract, and older payments were rounded to whole
 * hundreds, so a customer on a sale group sits a few centavos either side of
 * every cuota boundary for the rest of the term. Naming the cuota those
 * centavos landed in once printed "cuotas 4 y 5 de 12" for a single cuota.
 *
 * The line is drawn against the cuota's own size, so it scales with the
 * contract, and a sliver is only ever dropped in favour of a cuota the payment
 * did carry — a small payment that is all there is still gets named.
 */
const SLIVER_SHARE = 0.1;

function isSliver(installment: AppliedInstallment): boolean {
  return installment.applied < installment.installment * SLIVER_SHARE;
}

/** What a payment did to a lot's schedule, before it is put into words. */
export type AppliedSummary =
  /** Finished nothing: part of one cuota, and what that cuota still needs. */
  | { kind: "abono"; installment: AppliedInstallment }
  /** Finished cuotas `first` to `last`, `count` of them. */
  | { kind: "finished"; first: number; last: number; count: number };

/**
 * Which cuotas a payment was FOR, the decision behind both the receipt line
 * below and the WhatsApp message, so the two can never name different cuotas.
 * `null` when it touched none: a prima, or a cash sale with no schedule.
 */
export function appliedSummary(line: Pick<ReceiptLine, "appliedTo">): AppliedSummary | null {
  if (line.appliedTo.length === 0) {
    return null;
  }

  const carried = line.appliedTo.filter((installment) => !isSliver(installment));
  const touched = carried.length > 0 ? carried : line.appliedTo;
  const finished = touched.filter((installment) => installment.settled);

  if (finished.length === 0) {
    // Strictly greater, so an exact tie keeps the earlier cuota: `appliedTo`
    // arrives in schedule order.
    const principal = touched.reduce((best, installment) =>
      installment.applied > best.applied ? installment : best,
    );

    return { kind: "abono", installment: principal };
  }

  return {
    kind: "finished",
    first: finished[0]!.number,
    last: finished[finished.length - 1]!.number,
    count: finished.length,
  };
}

/**
 * What this money did to the lot's schedule, in one line under the lot code:
 *
 *   Cuota 4 de 12 · completa
 *   Abono a cuota 4 de 12 · faltan L. 10,000.00
 *   Cuotas 4 y 5 de 12 · completas
 *   Pago total · cuotas 4 a 12 de 12
 *
 * The single most useful line on the document: "recibí L 25,000" is a number,
 * "cuota 4 de 12 · completa" is an answer. It names the cuotas the payment
 * FINISHED. Money that went on into the next cuota is not announced here; it is
 * in the amount and the new balance, and the next cuota simply needs less.
 * Only when the payment finished nothing does the line say how far it got and
 * what is still missing.
 */
export function appliedLabel(line: AppliedLabelLine, money: MoneyView): string | null {
  const summary = appliedSummary(line);

  if (summary === null) {
    return null;
  }

  // "de 12" only when we know the total. A cash sale has no schedule, and
  // "cuota 3 de 0" is worse than saying nothing.
  const total = line.installmentCount > 0 ? ` de ${line.installmentCount}` : "";

  if (summary.kind === "abono") {
    const { number, remaining } = summary.installment;

    return `Abono a cuota ${number}${total} · faltan ${formatDocumentMoney(remaining, money)}`;
  }

  const { first, last, count } = summary;
  const paidOff = line.newBalance === 0;

  if (paidOff && count > 1) {
    return `Pago total · cuotas ${first} a ${last}${total}`;
  }

  if (count === 1) {
    return `Cuota ${first}${total} · ${paidOff ? "última cuota" : "completa"}`;
  }

  const range = count === 2 ? `${first} y ${last}` : `${first} a ${last}`;

  return `Cuotas ${range}${total} · completas`;
}

/**
 * Which cuotas a mora was for, as said out loud: "cuota 4", "cuotas 4 y 5",
 * "cuotas 4, 5 y 6", "la prima", "la prima y la cuota 1". 0 is the prima.
 */
export function moraCuotas(paid: readonly MoraPaid[]): string {
  const numbers = [...new Set(paid.map((entry) => entry.installment))];
  const prima = numbers.includes(0);
  const cuotas = numbers.filter((number) => number > 0);

  const list = (items: number[]) =>
    items.length === 1
      ? String(items[0])
      : `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;

  const named = cuotas.length === 0 ? "" : `${cuotas.length === 1 ? "cuota" : "cuotas"} ${list(cuotas)}`;

  if (!prima) {
    return named;
  }

  return named === "" ? "la prima" : `la prima y ${cuotas.length === 1 ? "la " : "las "}${named}`;
}

/** The total a payment put towards mora. */
export function moraTotal(paid: readonly MoraPaid[]): Cents {
  return cents(paid.reduce((total, entry) => total + entry.amount, 0));
}

/**
 * The part of a lot's money that paid mora, as its own line under the lot:
 *
 *   Recargo por mora · cuota 4 · L. 500.00
 *   Recargo por mora · cuotas 4 y 5 · L. 1,000.00
 *
 * Kept apart from the cuotas line above it, so a customer can always tell a
 * cuota from a fee. `null` when none of the money was mora.
 */
export function moraLabel(line: Pick<ReceiptLine, "moraPaid">, money: MoneyView): string | null {
  if (line.moraPaid.length === 0) {
    return null;
  }

  return `Recargo por mora · ${moraCuotas(line.moraPaid)} · ${formatDocumentMoney(moraTotal(line.moraPaid), money)}`;
}
