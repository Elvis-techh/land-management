import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { healthDetail } from "../src/features/contracts/contractPresentation";
import { debtorBehind } from "../src/features/dashboard/dashboardPresentation";
import type { Contract } from "../src/types";

/*
 * How far behind a contract is, in words. The prima is named on its own and
 * never counted as months: the contract that read «7 meses atrasados» owed a
 * L 160,000 prima and one cuota.
 */
const withHealth = (health: Partial<Contract["health"]>) =>
  ({
    health: { monthsBehind: 0, monthsAhead: 0, downPaymentLate: false, ...health },
  }) as Contract;

describe("the line under a contract's chip", () => {
  it("names the prima and counts only the cuotas as months", () => {
    assert.equal(
      healthDetail(withHealth({ downPaymentLate: true, monthsBehind: 1 })),
      "Prima pendiente · 1 mes atrasado",
    );
    assert.equal(healthDetail(withHealth({ downPaymentLate: true })), "Prima pendiente");
  });

  it("is unchanged for a contract whose prima is in", () => {
    assert.equal(healthDetail(withHealth({ monthsBehind: 2 })), "2 meses atrasados");
    assert.equal(healthDetail(withHealth({ monthsAhead: 1 })), "1 mes adelantado");
    assert.equal(healthDetail(withHealth({})), "");
  });
});

describe("the Panel's debtors list", () => {
  it("names the prima beside the months", () => {
    assert.equal(debtorBehind({ downPaymentLate: true, monthsBehind: 1 }), "Prima · 1 mes");
    assert.equal(debtorBehind({ downPaymentLate: true, monthsBehind: 0 }), "Prima");
    assert.equal(debtorBehind({ downPaymentLate: false, monthsBehind: 3 }), "3 meses");
  });
});
