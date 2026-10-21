import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ConstanciaPart } from "../src/features/constancias/api";
import {
  ANNEX_ROWS_PER_PAGE,
  annexPages,
  annexRows,
  joinSpanish,
  lotsPhrase,
  summarizePayments,
} from "../src/features/constancias/constanciaLayout";
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

function part(lotCode: string, projectName: string, paidOn: string[]): ConstanciaPart {
  return {
    contract: { id: lotCode, code: `CT-${lotCode}`, salePrice: L(50_000), signedOn: null },
    lot: { code: lotCode, projectName },
    payments: paidOn.map((date) => ({ paidOn: date, type: "installment", amount: L(25_000), receiptCode: null })),
    totalPaid: L(50_000),
    lastPaidOn: paidOn.at(-1) ?? null,
  };
}

describe("lotsPhrase", () => {
  it("names one lot, or several of one project together", () => {
    assert.equal(lotsPhrase([part("B-12", "Proyecto Santiago", [])]), "Lote B-12 del Proyecto Santiago");
    assert.equal(
      lotsPhrase([part("B-12", "Proyecto Santiago", []), part("B-13", "Proyecto Santiago", [])]),
      "Lotes B-12 y B-13 del Proyecto Santiago",
    );
  });

  it("names each lot with its own project when they differ", () => {
    assert.equal(
      lotsPhrase([part("B-12", "Proyecto Santiago", []), part("C-02", "Valle Verde", [])]),
      "Lote B-12 del Proyecto Santiago y Lote C-02 del Valle Verde",
    );
  });
});

describe("joinSpanish", () => {
  it("joins with commas and a final «y»", () => {
    assert.equal(joinSpanish(["A"]), "A");
    assert.equal(joinSpanish(["A", "B"]), "A y B");
    assert.equal(joinSpanish(["A", "B", "C"]), "A, B y C");
  });
});

describe("annexRows", () => {
  it("lists the lots one after another, each payment marked with its lot", () => {
    const rows = annexRows([
      part("B-12", "Proyecto Santiago", ["2026-01-05", "2026-02-05"]),
      part("B-13", "Proyecto Santiago", ["2026-01-20"]),
    ]);

    assert.deepEqual(
      rows.map((row) => [row.lotCode, row.paidOn]),
      [
        ["B-12", "2026-01-05"],
        ["B-12", "2026-02-05"],
        ["B-13", "2026-01-20"],
      ],
    );
  });
});
