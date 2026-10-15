import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { afterPaymentLabel } from "../src/features/receipts/afterPaymentLabel";
import type { AfterPayment } from "../src/features/receipts/api";
import type { MoneyView } from "../src/lib/money";
import { cents } from "../src/lib/money";
import type { AppliedInstallment } from "../src/types";

/*
 * The "después de este pago" line under a lot in «Registrar un pago». Its first
 * half is the receipt's own wording, so what is read while typing is what the
 * receipt will print.
 */

const HNL: MoneyView = { currency: "HNL", usdRate: 25 };

/** The label keeps "L." with its figure; written with plain spaces here for readability. */
const same = (label: string, expected: string) =>
  assert.equal(label.replace(/\u00a0/g, " "), expected);
const L = (amount: number) => cents(Math.round(amount * 100));

function cuota(number: number, applied: number, remaining = 0): AppliedInstallment {
  return {
    number,
    dueOn: "2026-11-05",
    applied: L(applied),
    settled: remaining === 0,
    installment: L(25_000),
    remaining: L(remaining),
  };
}

function after(overrides: Partial<AfterPayment>): AfterPayment {
  return {
    appliedTo: [],
    installmentCount: 12,
    newBalance: L(200_000),
    settled: false,
    nextDueAmount: L(25_000),
    nextInstallment: L(25_000),
    nextDueCredit: L(0),
    nextDueIsDownPayment: false,
    ...overrides,
  };
}

describe("afterPaymentLabel", () => {
  it("keeps «L.» on the same line as its figure", () => {
    assert.match(afterPaymentLabel(after({ appliedTo: [cuota(4, 25_000)] }), HNL), /próxima L\.\u00a025,000$/);
  });

  it("names the cuota a full payment completes, and the next one", () => {
    same(
      afterPaymentLabel(after({ appliedTo: [cuota(4, 25_000)] }), HNL),
      "Cuota 4 de 12 · completa · próxima L. 25,000",
    );
  });

  it("says how much of the next cuota is already covered", () => {
    same(
      afterPaymentLabel(
        after({
          appliedTo: [cuota(4, 25_000), cuota(5, 25_000), cuota(6, 5_000, 20_000)],
          newBalance: L(170_000),
          nextDueAmount: L(20_000),
          nextDueCredit: L(5_000),
        }),
        HNL,
      ),
      "Cuotas 4 y 5 de 12 · completas · próxima L. 25,000 · adelanto L. 5,000",
    );
  });

  it("gives the balance after a partial abono, without repeating what the cuota needs", () => {
    same(
      afterPaymentLabel(
        after({
          appliedTo: [cuota(4, 15_000, 10_000)],
          newBalance: L(210_000),
          nextDueAmount: L(10_000),
          nextDueCredit: L(15_000),
        }),
        HNL,
      ),
      "Abono a cuota 4 de 12 · faltan L. 10,000.00 · saldo L. 210,000",
    );
  });

  it("says the contract is paid when the balance reaches zero", () => {
    same(
      afterPaymentLabel(
        after({
          appliedTo: [cuota(12, 25_000)],
          newBalance: L(0),
          settled: true,
          nextDueAmount: L(0),
          nextInstallment: L(0),
        }),
        HNL,
      ),
      "Cuota 12 de 12 · última cuota · contrato pagado",
    );
  });

  it("says what is left of the prima while the prima is still owed", () => {
    same(
      afterPaymentLabel(
        after({ nextDueIsDownPayment: true, nextDueAmount: L(30_000), nextInstallment: L(50_000) }),
        HNL,
      ),
      "faltan L. 30,000 de prima",
    );
  });
});
