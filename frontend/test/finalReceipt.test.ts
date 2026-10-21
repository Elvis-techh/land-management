import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isFinalReceipt } from "../src/features/receipts/finalReceipt";
import { cents } from "../src/lib/money";

describe("isFinalReceipt", () => {
  it("is final when nothing is left to pay", () => {
    assert.equal(isFinalReceipt({ newBalance: cents(0), voidedAt: null }), true);
  });

  it("is not final while anything is left, even a centavo", () => {
    assert.equal(isFinalReceipt({ newBalance: cents(20_000_000), voidedAt: null }), false);
    assert.equal(isFinalReceipt({ newBalance: cents(1), voidedAt: null }), false);
  });

  it("is never final once voided", () => {
    assert.equal(
      isFinalReceipt({ newBalance: cents(0), voidedAt: "2026-10-20T15:00:00.000Z" }),
      false,
    );
  });
});
