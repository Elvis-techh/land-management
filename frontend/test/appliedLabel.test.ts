import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { appliedLabel, moraCuotas, moraLabel } from "../src/features/receipts/appliedLabel";
import type { AppliedLabelLine } from "../src/features/receipts/appliedLabel";
import type { MoneyView } from "../src/lib/money";
import { cents } from "../src/lib/money";

/*
 * The one line on a printed receipt that says what the money did to the
 * schedule: finished a cuota, finished two, went part of the way, or paid the
 * lot off.
 *
 * Pinned because it went wrong in production and the wrongness was plausible: a
 * receipt for a single L 25,000 cuota read "cuotas 4 y 5 de 12", which a
 * customer reads as being two cuotas further along than they are. The cause was
 * three centavos of the payment landing in cuota 5, left over from `splitEvenly`
 * rounding a sale-group share down to a whole L 100 months earlier.
 */

const HNL: MoneyView = { currency: "HNL", usdRate: 25 };
const CUOTA = 25_000;

/** [cuota number, lempiras this payment put in, lempiras still missing after it]. */
type Touch = [number, number, number];

function line(
  touches: Touch[],
  { installmentCount = 12, newBalance = 100_000, installment = CUOTA } = {},
): AppliedLabelLine {
  return {
    installmentCount,
    newBalance: cents(Math.round(newBalance * 100)),
    appliedTo: touches.map(([number, applied, remaining]) => ({
      number,
      dueOn: "2026-08-18",
      applied: cents(Math.round(applied * 100)),
      settled: remaining === 0,
      installment: cents(Math.round(installment * 100)),
      remaining: cents(Math.round(remaining * 100)),
    })),
  };
}

const label = (value: AppliedLabelLine) => appliedLabel(value, HNL);

describe("appliedLabel", () => {
  it("says a cuota paid in full is complete", () => {
    assert.equal(label(line([[4, CUOTA, 0]])), "Cuota 4 de 12 · completa");
  });

  it("says what is still missing when the payment falls short of a cuota", () => {
    assert.equal(
      label(line([[4, 15_000, 10_000]])),
      "Abono a cuota 4 de 12 · faltan L. 10,000.00",
    );
  });

  it("names every cuota a larger payment finished", () => {
    assert.equal(
      label(line([[4, CUOTA, 0], [5, CUOTA, 0]])),
      "Cuotas 4 y 5 de 12 · completas",
    );
    assert.equal(
      label(line([[4, CUOTA, 0], [5, CUOTA, 0], [6, CUOTA, 0]])),
      "Cuotas 4 a 6 de 12 · completas",
    );
  });

  it("does not announce the part of a payment that spilled into the next cuota", () => {
    // L 55,000: cuotas 4 and 5, and L 5,000 towards 6. The receipt names what
    // was finished; the advance is visible in the amount and the balance.
    assert.equal(
      label(line([[4, CUOTA, 0], [5, CUOTA, 0], [6, 5_000, 20_000]])),
      "Cuotas 4 y 5 de 12 · completas",
    );
  });

  it("says a cuota begun earlier was completed by this payment", () => {
    // L 15,000 last week, the other L 10,000 today.
    assert.equal(label(line([[4, 10_000, 0]])), "Cuota 4 de 12 · completa");
  });

  it("ignores a rounding crumb in the next cuota", () => {
    // The production receipt: L 24,999.97 finishing cuota 4 and three centavos
    // of cuota 5. It once read "cuotas 4 y 5 de 12".
    assert.equal(
      label(line([[4, 24_999.97, 0], [5, 0.03, 24_999.97]])),
      "Cuota 4 de 12 · completa",
    );
  });

  it("ignores a crumb that finished the previous cuota", () => {
    // An earlier payment left cuota 4 three centavos short. This one closes
    // those centavos and pays most of cuota 5; cuota 4 is not this payment's.
    assert.equal(
      label(line([[4, 0.03, 0], [5, 24_999.97, 0]])),
      "Cuota 5 de 12 · completa",
    );
  });

  it("names the cuota the money mostly went to when the rest was a sliver", () => {
    // A hundred lempiras finished cuota 4; the rest went most of the way into 5.
    assert.equal(
      label(line([[4, 100, 0], [5, 24_900, 100]])),
      "Abono a cuota 5 de 12 · faltan L. 100.00",
    );
  });

  it("still names a small payment that is all there is", () => {
    // The sliver rule never leaves a receipt with nothing to say.
    assert.equal(label(line([[4, 100, 0]])), "Cuota 4 de 12 · completa");
    assert.equal(
      label(line([[4, 100, 24_900]])),
      "Abono a cuota 4 de 12 · faltan L. 24,900.00",
    );
  });

  it("says a payment that clears the contract paid it in full", () => {
    const touches: Touch[] = [4, 5, 6, 7, 8, 9, 10, 11, 12].map((number) => [number, CUOTA, 0]);

    assert.equal(
      label(line(touches, { newBalance: 0 })),
      "Pago total · cuotas 4 a 12 de 12",
    );
  });

  it("calls the last ordinary cuota the last one", () => {
    assert.equal(label(line([[12, CUOTA, 0]], { newBalance: 0 })), "Cuota 12 de 12 · última cuota");
  });

  it("drops the total when the contract has no schedule", () => {
    // "cuota 1 de 0" would be worse than no total at all.
    assert.equal(
      label(line([[1, CUOTA, 0]], { installmentCount: 0 })),
      "Cuota 1 · completa",
    );
  });

  it("says nothing when the money went to no cuota at all", () => {
    // A prima, or a payment on a contract with no schedule to place it in.
    assert.equal(label(line([])), null);
  });
});

describe("moraLabel", () => {
  const paid = (...entries: Array<[number, number]>) =>
    entries.map(([installment, amount]) => ({ installment, amount: cents(Math.round(amount * 100)) }));

  it("prints the mora on a line of its own, with its cuotas and total", () => {
    assert.equal(
      moraLabel({ moraPaid: paid([4, 500]) }, HNL)?.replace(/\u00a0/g, " "),
      "Recargo por mora · cuota 4 · L. 500.00",
    );
    assert.equal(
      moraLabel({ moraPaid: paid([4, 500], [5, 250]) }, HNL)?.replace(/\u00a0/g, " "),
      "Recargo por mora · cuotas 4 y 5 · L. 750.00",
    );
  });

  it("says nothing when none of the money was mora", () => {
    assert.equal(moraLabel({ moraPaid: [] }, HNL), null);
  });

  it("names the prima as the prima", () => {
    assert.equal(moraCuotas(paid([0, 100])), "la prima");
    assert.equal(moraCuotas(paid([0, 100], [1, 50])), "la prima y la cuota 1");
    assert.equal(moraCuotas(paid([4, 1], [5, 1], [6, 1])), "cuotas 4, 5 y 6");
  });
});
