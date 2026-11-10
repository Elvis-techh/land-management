import type { Cents } from "../../lib/money";
import { cents } from "../../lib/money";
import type { AfterPayment } from "./api";

/*
 * What one lot's money does, in parts, for the list under the lot in
 * «Registrar un pago» (the owner's «A», 10 Nov 2026):
 *
 *   Mora       L. 500
 *   Prima      L. 29,500
 *   Total      L. 30,000
 *
 * Worked out from the server's preview (GET /contracts/:id/after-payment),
 * which divides the money as the save will, at the payment's own date.
 */

export interface PaymentPart {
  label: string;
  amount: Cents;
}

/**
 * The parts, in the order the money is spent: mora, prima, the cuotas due, then
 * anything ahead of them. Mora is listed even at L. 0 when the lot carries it,
 * so nobody has to wonder whether it was taken; the others only when they get
 * something.
 *
 * «Cuota» is what goes to the cuotas due by the payment's date, or, when none
 * is due yet, to the next one: the cuota the lot's top line asks for.
 * «Adelanto» is what reaches the cuotas after that. A lot with no schedule (a
 * reservation, a cash sale) gets an «Abono» to its price instead.
 */
export function paymentParts(
  after: AfterPayment,
  amount: Cents,
  paidOn: string,
  carriesMora: boolean,
): PaymentPart[] {
  const parts: PaymentPart[] = [];
  const first = after.appliedTo[0];
  const cutoff = first && first.dueOn > paidOn ? first.dueOn : paidOn;
  const due = after.appliedTo.filter((installment) => installment.dueOn <= cutoff);
  const ahead = after.appliedTo.filter((installment) => installment.dueOn > cutoff);
  const sum = (list: typeof due) => list.reduce((total, installment) => total + installment.applied, 0);
  const toCuotas = sum(due) + sum(ahead);
  // Past the end of the schedule, or a lot without one.
  const rest = amount - after.mora - after.toDownPayment - toCuotas;

  if (carriesMora || after.mora > 0) {
    parts.push({ label: "Mora", amount: after.mora });
  }

  if (after.toDownPayment > 0) {
    parts.push({ label: "Prima", amount: after.toDownPayment });
  }

  if (due.length > 0) {
    parts.push({ label: due.length > 1 ? "Cuotas" : "Cuota", amount: cents(sum(due)) });
  }

  const advance = sum(ahead) + (after.installmentCount > 0 ? Math.max(0, rest) : 0);

  if (advance > 0) {
    parts.push({ label: "Adelanto", amount: cents(advance) });
  }

  if (after.installmentCount === 0 && rest > 0) {
    parts.push({ label: "Abono", amount: cents(rest) });
  }

  parts.push({ label: "Total", amount });

  return parts;
}
