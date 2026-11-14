import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AfterPayment } from "../src/features/receipts/api";
import { paymentParts } from "../src/features/receipts/paymentParts";
import { cents } from "../src/lib/money";
import type { AppliedInstallment } from "../src/types";

/*
 * The list under a lot in «Registrar un pago»: Mora, Prima, Cuota, Adelanto,
 * Total (the owner's «A», 10 Nov 2026).
 */

const L = (amount: number) => cents(Math.round(amount * 100));

function cuota(number: number, dueOn: string, applied: number): AppliedInstallment {
  return { number, dueOn, applied: L(applied), settled: true, installment: L(7_000), remaining: L(0) };
}

function after(overrides: Partial<AfterPayment>): AfterPayment {
  return {
    appliedTo: [],
    installmentCount: 60,
    mora: L(0),
    toDownPayment: L(0),
    moraPending: L(0),
    newBalance: L(400_000),
    settled: false,
    nextDueAmount: L(7_000),
    nextInstallment: L(7_000),
    nextDueCredit: L(0),
    nextDueIsDownPayment: false,
    ...overrides,
  };
}

const read = (parts: ReturnType<typeof paymentParts>) => parts.map(({ label, amount }) => [label, amount / 100]);

describe("paymentParts", () => {
  it("the owner's screenshot, paid today: the mora first, then the prima", () => {
    assert.deepEqual(read(paymentParts(after({ mora: L(500), toDownPayment: L(29_500) }), L(30_000), "2026-11-10", true)), [
      ["Mora", 500],
      ["Prima", 29_500],
      ["Total", 30_000],
    ]);
  });

  it("the same payment dated 30 April: no mora yet that day, so «Mora L. 0» and the whole prima", () => {
    assert.deepEqual(read(paymentParts(after({ toDownPayment: L(30_000) }), L(30_000), "2026-04-30", true)), [
      ["Mora", 0],
      ["Prima", 30_000],
      ["Total", 30_000],
    ]);
  });

  it("no «Mora» line on a lot that carries none", () => {
    assert.deepEqual(read(paymentParts(after({ toDownPayment: L(30_000) }), L(30_000), "2026-11-10", false)), [
      ["Prima", 30_000],
      ["Total", 30_000],
    ]);
  });

  it("late cuotas are «Cuotas»; the one not due yet is an «Adelanto»", () => {
    const appliedTo = [cuota(3, "2026-09-30", 7_000), cuota(4, "2026-10-30", 7_000), cuota(5, "2026-11-30", 3_000)];
    assert.deepEqual(read(paymentParts(after({ appliedTo, mora: L(500) }), L(17_500), "2026-11-10", true)), [
      ["Mora", 500],
      ["Cuotas", 14_000],
      ["Adelanto", 3_000],
      ["Total", 17_500],
    ]);
  });

  it("up to date: the next cuota is the «Cuota», even before it falls due", () => {
    const appliedTo = [cuota(5, "2026-11-30", 7_000), cuota(6, "2026-12-30", 2_000)];
    assert.deepEqual(read(paymentParts(after({ appliedTo }), L(9_000), "2026-11-10", false)), [
      ["Cuota", 7_000],
      ["Adelanto", 2_000],
      ["Total", 9_000],
    ]);
  });

  it("a lot with no schedule gets an «Abono»", () => {
    assert.deepEqual(read(paymentParts(after({ installmentCount: 0 }), L(5_000), "2026-11-10", false)), [
      ["Abono", 5_000],
      ["Total", 5_000],
    ]);
  });
});
