import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { saldoDifference } from "../src/features/receipts/saldoDifference";
import type { MoneyView } from "../src/lib/money";
import { cents } from "../src/lib/money";

/*
 * «Registrar un pago» with an earlier date shows a lot's saldo on that day and
 * its saldo today. When they differ, one line says why (owner, 17 Nov 2026);
 * when they are the same, nothing.
 */

const HNL: MoneyView = { currency: "HNL", usdRate: 25 };
const L = (amount: number) => cents(Math.round(amount * 100));

/** The sentence with plain spaces: the figures keep «L.» with them by a no-break space. */
const say = (then: number, now: number, moraChange: number, paidOn = "2026-07-15") =>
  saldoDifference({ then: L(then), now: L(now), moraChange: Math.round(moraChange * 100) }, paidOn, HNL)?.replace(
    / /g,
    " ",
  ) ?? null;

describe("why the saldo on the payment's day and today's differ", () => {
  it("adds the mora charged after the date, as the owner asked for it", () => {
    // C-10: L. 350,000 on 15 jul, L. 350,500 today, the L. 500 charged on cuota 3 after it.
    assert.equal(say(350_000, 350_500, 500), "L. 350,000 + L. 500 de mora cargada después del 15 jul");
  });

  it("says nothing when the two are the same", () => {
    assert.equal(say(350_000, 350_000, 0), null);
  });

  it("subtracts money paid after the date", () => {
    assert.equal(say(100_000, 80_000, 0), "L. 100,000 − L. 20,000 de pagos después del 15 jul");
  });

  it("says both when mora was charged and money was paid after the date", () => {
    assert.equal(
      say(100_000, 80_500, 500),
      "L. 100,000 + L. 500 de mora cargada − L. 20,000 de pagos después del 15 jul",
    );
  });

  it("says mora paid or forgiven after the date as a subtraction", () => {
    assert.equal(say(100_000, 99_700, -300), "L. 100,000 − L. 300 de mora pagada o perdonada después del 15 jul");
  });

  it("never leaves a difference unexplained", () => {
    // Nothing known to account for the extra L. 50: it is still said.
    assert.equal(say(100_000, 100_050, 0), "L. 100,000 + L. 50 de otros cambios después del 15 jul");
  });

  it("always adds up to the two figures it was given", () => {
    for (const [then, now, mora] of [
      [350_000, 350_500, 500],
      [100_000, 80_500, 500],
      [100_000, 99_700, -300],
      [100_000, 80_000, 0],
    ] as const) {
      const sentence = say(then, now, mora)!;
      const signed = [...sentence.matchAll(/([+−]) L\. ([\d,]+)/g)].map(
        ([, sign, value]) => (sign === "+" ? 1 : -1) * Number(value!.replace(/,/g, "")),
      );

      assert.equal(then + signed.reduce((sum, value) => sum + value, 0), now, sentence);
    }
  });
});
