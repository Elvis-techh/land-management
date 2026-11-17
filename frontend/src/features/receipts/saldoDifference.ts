import type { Cents, MoneyView } from "../../lib/money";
import { cents, formatMoney } from "../../lib/money";
import { shortDate } from "./moraAtPayment";

/**
 * Why a saldo on a past day and the saldo today are two figures, in a sentence.
 *
 * «Registrar un pago» with an earlier date shows each lot's saldo on THAT day,
 * the one the receipt prints as «Balance Anterior», and today's saldo beside
 * it. They are two days, so they differ whenever something happened in
 * between: mora charged after the payment's date, or money paid after it. Left
 * unsaid, two figures for one lot read as one of them being wrong (owner,
 * 17 Nov 2026: «the user is going to be wondering which one is the real
 * value»). So when they differ, one line adds the one to the other:
 *
 *   L. 350,000 + L. 500 de mora cargada después del 15 jul
 *
 * and when they are the same it says nothing.
 *
 * `moraChange` is how much more mora is owed today than was owed that day.
 * The rest of the difference is money paid after that day. Neither can be
 * invented: the two figures are the ones on screen, so the sentence always
 * adds up to what is shown. A remainder that is neither (it should not happen)
 * is still said, as «otros cambios», rather than left out.
 */
export function saldoDifference(
  figures: {
    /** The saldo on the payment's day, mora included. */
    then: Cents;
    /** The saldo today (or after the payment, today), mora included. */
    now: Cents;
    /** The mora owed now minus the mora owed that day, in centavos. */
    moraChange: number;
  },
  paidOn: string,
  money: MoneyView,
): string | null {
  const difference = figures.now - figures.then;

  if (difference === 0) {
    return null;
  }

  const rest = difference - figures.moraChange;
  const amount = (value: number) => formatMoney(cents(Math.abs(value)), money);
  const parts: string[] = [];

  if (figures.moraChange > 0) {
    parts.push(`+ ${amount(figures.moraChange)} de mora cargada`);
  } else if (figures.moraChange < 0) {
    parts.push(`− ${amount(figures.moraChange)} de mora pagada o perdonada`);
  }

  if (rest < 0) {
    parts.push(`− ${amount(rest)} de pagos`);
  } else if (rest > 0) {
    parts.push(`+ ${amount(rest)} de otros cambios`);
  }

  return `${formatMoney(figures.then, money)} ${parts.join(" ")} después del ${shortDate(paidOn)}`;
}
