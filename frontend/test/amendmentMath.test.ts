import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  divideByWeights,
  nextAmendedCode,
  planAmendment,
} from "../src/features/contracts/amendmentMath";

const lempiras = (amount: number) => Math.round(amount * 100);

/*
 * The case the adenda was built for: L 800,000 for three lots, L 150,000 of it
 * already sent as the new deal's prima, the rest in three cuotas.
 */
const threeLots = [
  { areaM2: 320, manualPriceCents: Number.NaN },
  { areaM2: 339.5, manualPriceCents: Number.NaN },
  { areaM2: 338.58, manualPriceCents: Number.NaN },
];

describe("dividing an adenda's total between its lots", () => {
  it("splits equally in whole lempiras, the odd ones on the first lots", () => {
    assert.deepEqual(divideByWeights(lempiras(800_000), [1, 1, 1]), [
      lempiras(266_667),
      lempiras(266_667),
      lempiras(266_666),
    ]);
  });

  it("always adds back up to the total, whatever the weights", () => {
    const parts = divideByWeights(lempiras(800_000), [320, 339.5, 338.58]);

    assert.equal(parts.reduce((sum, part) => sum + part, 0), lempiras(800_000));
    // The largest lot carries the most, the smallest the least.
    assert.ok(parts[1]! > parts[2]! && parts[2]! > parts[0]!);
    // And every part is still a whole lempira.
    assert.ok(parts.every((part) => part % 100 === 0));
  });

  it("divides to the centavo only when the total itself has centavos", () => {
    const parts = divideByWeights(100_001, [1, 1]);
    assert.deepEqual(parts, [50_001, 50_000]);
  });

  it("falls back to equal parts when there is nothing to weigh by", () => {
    assert.deepEqual(divideByWeights(lempiras(300), [0, 0, 0]), [
      lempiras(100),
      lempiras(100),
      lempiras(100),
    ]);
  });
});

describe("planning an adenda", () => {
  it("gives each lot its price, prima and cuota for the deal as agreed", () => {
    const plan = planAmendment({
      mode: "equal",
      totalCents: lempiras(800_000),
      downPaymentTotalCents: lempiras(150_000),
      lots: threeLots,
      financed: true,
      termMonths: 3,
    });

    assert.equal(plan.totalCents, lempiras(800_000));
    assert.deepEqual(
      plan.lines.map((line) => line.downPaymentCents),
      [lempiras(50_000), lempiras(50_000), lempiras(50_000)],
    );
    // L 216,667 over three months, rounded UP to the lempira.
    assert.deepEqual(
      plan.lines.map((line) => line.monthlyPaymentCents),
      [lempiras(72_223), lempiras(72_223), lempiras(72_222)],
    );
    const financed = plan.lines.reduce((sum, line) => sum + line.financedCents, 0);
    assert.equal(financed, lempiras(650_000));
  });

  it("keeps the prima in proportion to each lot's price when split by area", () => {
    const plan = planAmendment({
      mode: "area",
      totalCents: lempiras(800_000),
      downPaymentTotalCents: lempiras(150_000),
      lots: threeLots,
      financed: true,
      termMonths: 3,
    });

    assert.equal(
      plan.lines.reduce((sum, line) => sum + line.downPaymentCents, 0),
      lempiras(150_000),
    );
    for (const line of plan.lines) {
      assert.ok(line.downPaymentCents < line.salePriceCents);
    }
  });

  it("adds the typed prices up when the split is by hand", () => {
    const plan = planAmendment({
      mode: "manual",
      totalCents: 0,
      downPaymentTotalCents: 0,
      lots: [
        { areaM2: 320, manualPriceCents: lempiras(260_000) },
        { areaM2: 339.5, manualPriceCents: lempiras(270_000) },
        { areaM2: 338.58, manualPriceCents: Number.NaN },
      ],
      financed: false,
      termMonths: null,
    });

    assert.equal(plan.totalCents, lempiras(530_000));
    assert.deepEqual(
      plan.lines.map((line) => line.monthlyPaymentCents),
      [null, null, null],
    );
  });
});

describe("foreseeing the adenda's contract number", () => {
  it("adds -A1 to a contract that has never been amended", () => {
    assert.equal(nextAmendedCode("CT-2026-011", ["CT-2026-011", "CT-2026-012"]), "CT-2026-011-A1");
  });

  it("counts on from the root when amending an amended contract", () => {
    assert.equal(
      nextAmendedCode("CT-2026-011-A1", ["CT-2026-011", "CT-2026-011-A1"]),
      "CT-2026-011-A2",
    );
  });
});
