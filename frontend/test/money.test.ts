import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cents, formatDocumentMoney, formatDocumentMoneyParts, typedCents } from "../src/lib/money";

describe("typedCents", () => {
  it("reads the field as lempiras", () => {
    assert.equal(typedCents("55,358.08"), 5_535_808);
    assert.equal(typedCents("25,000"), 2_500_000);
    assert.equal(typedCents("1,750,000.5"), 175_000_050);
  });

  it("lands on whole centavos even where floating point does not", () => {
    // 0.29 * 100 is 28.999999999999996 in JavaScript.
    assert.equal(typedCents("0.29"), 29);
    assert.equal(typedCents("333.33"), 33_333);
  });

  it("counts an empty or half-typed field as nothing", () => {
    assert.equal(typedCents(""), 0);
    assert.equal(typedCents("   "), 0);
    assert.equal(typedCents("."), 0);
    assert.equal(typedCents("0"), 0);
  });
});

describe("formatDocumentMoneyParts", () => {
  it("is formatDocumentMoney split at the space, for a «L.» column of its own", () => {
    for (const amount of [0, 25_000, 3_000_000, 42_050_000, 125_000_000]) {
      for (const view of [
        { currency: "HNL" as const, usdRate: 1 },
        { currency: "USD" as const, usdRate: 24.5 },
      ]) {
        const { symbol, value } = formatDocumentMoneyParts(cents(amount), view);
        assert.equal(`${symbol} ${value}`, formatDocumentMoney(cents(amount), view));
      }
    }
  });
});
