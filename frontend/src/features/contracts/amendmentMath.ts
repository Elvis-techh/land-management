/**
 * The arithmetic of an adenda, before the server has seen it.
 *
 * An adenda is agreed as ONE figure for the whole purchase — "L 800,000 por los
 * tres lotes, el resto en tres meses" — while Lindero keeps a contract, a price
 * and a balance per lot, because lots are released and titled one at a time.
 * Something has to turn the one figure into three, and it has to do it in a way
 * that adds back up to the centavo and that somebody can look at before saving.
 * That is this file. Nothing here reads or writes anything.
 */

import { suggestMonthlyPayment } from "./contractSchedule";

/** How the new total is divided between the lots. */
export type SplitMode = "equal" | "area" | "manual";

/**
 * Divide `totalCents` in proportion to `weights`, so the parts sum to exactly
 * the total.
 *
 * Largest remainder: every part is first rounded down, and the units left over
 * go one each to the parts that lost the most in the rounding — the earlier
 * lot on a tie, so the same figures always come out the same way.
 *
 * The unit is a whole LEMPIRA whenever the total is one. Land is sold in round
 * numbers, and "L 266,667" is a price somebody can say out loud where
 * "L 266,666.67" is not; the odd lempira lands on the first lots, which is the
 * difference nobody minds. A total that itself carries centavos is divided to
 * the centavo, since there is no round answer to give.
 *
 * Weights of zero everywhere (no areas on file, say) fall back to equal parts
 * rather than dividing by nothing.
 */
export function divideByWeights(totalCents: number, weights: readonly number[]): number[] {
  if (weights.length === 0) {
    return [];
  }

  const usable = weights.map((weight) => (Number.isFinite(weight) && weight > 0 ? weight : 0));
  const sum = usable.reduce((total, weight) => total + weight, 0);
  const shares = sum > 0 ? usable : usable.map(() => 1);
  const shareSum = sum > 0 ? sum : shares.length;

  const unit = totalCents % 100 === 0 ? 100 : 1;
  const units = Math.round(totalCents / unit);

  const exact = shares.map((share) => (units * share) / shareSum);
  const parts = exact.map((value) => Math.floor(value));
  let leftover = units - parts.reduce((total, part) => total + part, 0);

  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  for (const { index } of byRemainder) {
    if (leftover <= 0) {
      break;
    }
    parts[index]! += 1;
    leftover -= 1;
  }

  return parts.map((part) => part * unit);
}

/** One lot of the purchase, as far as dividing money between them goes. */
export interface AmendmentLot {
  /** Square metres, straight off the lot. Only used by the "según el área" split. */
  areaM2: number;
  /** What was typed for this lot when the split is "a mano"; NaN when blank or unreadable. */
  manualPriceCents: number;
}

export interface AmendmentLine {
  salePriceCents: number;
  downPaymentCents: number;
  /** What is left to pay in cuotas: price minus prima. */
  financedCents: number;
  /** The cuota for this lot, or `null` on a sale de contado. */
  monthlyPaymentCents: number | null;
}

export interface AmendmentPlan {
  /** Sum of the new prices — the total typed, or the lots added up when typed by hand. */
  totalCents: number;
  lines: AmendmentLine[];
}

/**
 * Every lot's new price, prima and cuota, from the figures the dialog holds.
 *
 * The prima is divided in proportion to each lot's new PRICE rather than
 * equally or by area. It is a share of the price, so a lot that costs more
 * carries more of it, and a prima that follows the price never ends up larger
 * than the price it belongs to.
 *
 * The cuota is the financed part over the term, rounded UP to a whole lempira —
 * the same starting point the Nuevo contrato form suggests, and for the same
 * reason: rounding up means the schedule can never come up short and grow an
 * extra month, and the last cuota simply absorbs the few lempiras over.
 */
export function planAmendment(input: {
  mode: SplitMode;
  /** The typed total. Ignored when the split is "a mano". */
  totalCents: number;
  downPaymentTotalCents: number;
  lots: readonly AmendmentLot[];
  financed: boolean;
  termMonths: number | null;
}): AmendmentPlan {
  const prices =
    input.mode === "manual"
      ? input.lots.map((lot) => (Number.isFinite(lot.manualPriceCents) ? lot.manualPriceCents : 0))
      : divideByWeights(
          input.totalCents,
          input.mode === "area" ? input.lots.map((lot) => lot.areaM2) : input.lots.map(() => 1),
        );

  const primas = input.financed ? divideByWeights(input.downPaymentTotalCents, prices) : prices.map(() => 0);

  const lines = prices.map((salePriceCents, index) => {
    const downPaymentCents = primas[index] ?? 0;
    const financedCents = Math.max(0, salePriceCents - downPaymentCents);
    const monthlyPaymentCents =
      input.financed && input.termMonths !== null && input.termMonths >= 1
        ? suggestMonthlyPayment(financedCents, input.termMonths)
        : null;

    return { salePriceCents, downPaymentCents, financedCents, monthlyPaymentCents };
  });

  return {
    totalCents: prices.reduce((total, price) => total + price, 0),
    lines,
  };
}

/**
 * The number the server will give the contract an adenda writes, foreseen from
 * the list: CT-2026-011 → CT-2026-011-A1, and CT-2026-011-A1 → CT-2026-011-A2.
 *
 * A preview only. The server assigns the real one inside the transaction that
 * writes it (see `amendedCode` in routes/contracts.ts), so this can only ever be
 * wrong about a number that is about to be corrected by the screen reloading.
 */
export function nextAmendedCode(previousCode: string, existingCodes: readonly string[]): string {
  const root = previousCode.replace(/-A\d+$/, "");
  const prefix = `${root}-A`;

  const highest = existingCodes.reduce((max, code) => {
    if (!code.startsWith(prefix)) {
      return max;
    }
    const number = Number(code.slice(prefix.length));
    return Number.isInteger(number) ? Math.max(max, number) : max;
  }, 0);

  return `${prefix}${highest + 1}`;
}
