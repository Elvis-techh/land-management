import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ANNEX_ROWS_PER_PAGE, annexPages, summarizePayments } from "../src/features/constancias/constanciaLayout";
import { cents } from "../src/lib/money";

const L = (amount: number) => cents(Math.round(amount * 100));

/** A prima, then `count` monthly cuotas from February 2021. */
function history(count: number) {
  const cuotas = Array.from({ length: count }, (_, index) => {
    const month = index + 1;
    const year = 2021 + Math.floor(month / 12);

    return {
      paidOn: `${year}-${String((month % 12) + 1).padStart(2, "0")}-15`,
      type: "installment",
      amount: L(5_000),
      receiptCode: `IM-${String(index).padStart(12, "0")}`,
    };
  });

  return [{ paidOn: "2021-01-15", type: "down_payment", amount: L(25_000), receiptCode: null }, ...cuotas];
}

describe("summarizePayments", () => {
  it("groups the history by kind, prima first, with the dates it ran between", () => {
    const summary = summarizePayments([
      ...history(60),
      { paidOn: "2026-02-20", type: "full_payment", amount: L(12_000), receiptCode: null },
    ]);

    assert.deepEqual(
      summary.map((line) => [line.label, line.count, line.firstOn, line.lastOn, line.total]),
      [
        ["Prima", 1, "2021-01-15", "2021-01-15", L(25_000)],
        ["Cuota", 60, "2021-02-15", "2026-01-15", L(300_000)],
        ["Pago total", 1, "2026-02-20", "2026-02-20", L(12_000)],
      ],
    );
  });

  it("has nothing to say about no payments", () => {
    assert.deepEqual(summarizePayments([]), []);
  });
});

describe("annexPages", () => {
  it("cuts the history into sheets of a fixed size, in order", () => {
    const payments = history(99);
    const pages = annexPages(payments);

    assert.equal(pages.length, Math.ceil(100 / ANNEX_ROWS_PER_PAGE));
    assert.deepEqual(pages.flat(), payments);
    assert.ok(pages.slice(0, -1).every((page) => page.length === ANNEX_ROWS_PER_PAGE));
  });

  it("needs no sheet for no payments", () => {
    assert.deepEqual(annexPages([]), []);
  });
});
