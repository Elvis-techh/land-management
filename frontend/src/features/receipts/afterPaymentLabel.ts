import type { MoneyView } from "../../lib/money";
import { formatMoney } from "../../lib/money";
import { appliedLabel } from "./appliedLabel";
import type { AfterPayment } from "./api";

/**
 * The "después de este pago" line under a lot in «Registrar un pago»:
 *
 *   Cuota 4 de 12 · completa · próxima L. 25,000
 *   Cuotas 4 y 5 de 12 · completas · próxima L. 25,000 · adelanto L. 5,000
 *   Abono a cuota 4 de 12 · faltan L. 10,000.00 · saldo L. 210,000
 *   Cuota 6 de 6 · última cuota · contrato pagado
 *   faltan L. 30,000 de prima
 *   mora L. 500 · Cuota 4 de 12 · completa · próxima L. 25,000
 *
 * The first part is the receipt's own wording (`appliedLabel`), so what the
 * person reads while typing is what the receipt will print. The rest is what
 * the lot owes afterwards: the next cuota and any advance on it, or the rest of
 * the prima, or that nothing is left.
 *
 * With mora owed, the part of the money that pays it comes first, as the
 * receipt lists it, and any mora still owed afterwards comes last.
 */
export function afterPaymentLabel(after: AfterPayment, money: MoneyView): string {
  const parts: string[] = [];
  const applied = appliedLabel(after, money);

  if (after.mora > 0) {
    parts.push(`mora ${formatMoney(after.mora, money)}`);
  }

  if (applied !== null) {
    parts.push(applied);
  }

  // A partial abono: the receipt wording already says what the cuota still
  // needs ("faltan L. 10,000.00"), so "próxima … · adelanto …" would say it
  // twice. The balance is the useful thing left to add.
  const isAbono = applied !== null && !after.appliedTo.some((installment) => installment.settled);

  if (after.settled) {
    parts.push("contrato pagado");
  } else if (isAbono) {
    parts.push(`saldo ${formatMoney(after.newBalance, money)}`);
  } else if (after.nextDueIsDownPayment) {
    parts.push(`faltan ${formatMoney(after.nextDueAmount, money)} de prima`);
  } else if (after.nextDueCredit > 0) {
    // The next cuota is already started: say how much of it is covered.
    parts.push(
      `próxima ${formatMoney(after.nextInstallment, money)} · adelanto ${formatMoney(after.nextDueCredit, money)}`,
    );
  } else if (after.nextInstallment > 0) {
    parts.push(`próxima ${formatMoney(after.nextInstallment, money)}`);
  } else {
    parts.push(`saldo ${formatMoney(after.newBalance, money)}`);
  }

  if (after.moraPending > 0) {
    parts.push(`mora pendiente ${formatMoney(after.moraPending, money)}`);
  }

  // A non-breaking space after the currency sign: when the line wraps on a
  // phone, "L." must not be left at the end of one line and its figure on the
  // next.
  return parts.join(" · ").replace(/(L\.|\$) /g, "$1\u00a0");
}
