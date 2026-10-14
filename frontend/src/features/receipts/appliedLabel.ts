import type { MoneyView } from "../../lib/money";
import { formatDocumentMoney } from "../../lib/money";
import type { AppliedInstallment, ReceiptLine } from "../../types";

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
  if (line.appliedTo.length === 0) {
    return null;
  }

  const carried = line.appliedTo.filter((installment) => !isSliver(installment));
  const touched = carried.length > 0 ? carried : line.appliedTo;
  const finished = touched.filter((installment) => installment.settled);

  // "de 12" only when we know the total. A cash sale has no schedule, and
  // "cuota 3 de 0" is worse than saying nothing.
  const total = line.installmentCount > 0 ? ` de ${line.installmentCount}` : "";

  if (finished.length === 0) {
    // Strictly greater, so an exact tie keeps the earlier cuota: `appliedTo`
    // arrives in schedule order.
    const principal = touched.reduce((best, installment) =>
      installment.applied > best.applied ? installment : best,
    );

    return `Abono a cuota ${principal.number}${total} · faltan ${formatDocumentMoney(principal.remaining, money)}`;
  }

  const first = finished[0]!.number;
  const last = finished[finished.length - 1]!.number;
  const paidOff = line.newBalance === 0;

  if (paidOff && finished.length > 1) {
    return `Pago total · cuotas ${first} a ${last}${total}`;
  }

  if (finished.length === 1) {
    return `Cuota ${first}${total} · ${paidOff ? "última cuota" : "completa"}`;
  }

  const range = finished.length === 2 ? `${first} y ${last}` : `${first} a ${last}`;

  return `Cuotas ${range}${total} · completas`;
}
