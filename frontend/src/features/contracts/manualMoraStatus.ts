import type { MoneyView } from "../../lib/money";
import { cents, formatMoney } from "../../lib/money";

/**
 * Where one mora put on by hand stands, in the words of the contract's panel.
 *
 * Nothing unpaid is not the same as paid: «Perdonar» clears a charge too, and
 * nobody paid that money, so the word has to tell them apart.
 */
export function manualMoraStatus(
  entry: { amountCents: number; pendingCents: number; forgivenCents: number },
  money: MoneyView,
): string {
  if (entry.pendingCents > 0) {
    return entry.pendingCents === entry.amountCents
      ? "Pendiente"
      : `Faltan ${formatMoney(cents(entry.pendingCents), money)}`;
  }

  if (entry.forgivenCents === 0) {
    return "Pagada";
  }

  return entry.forgivenCents === entry.amountCents ? "Perdonada" : "Pagada en parte, perdonada en parte";
}
