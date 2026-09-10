import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { lotStatus } from "../src/features/lots/lotStatus";
import { cents } from "../src/lib/money";
import type { ContractStatus, Lot, LotHolding, SaleType } from "../src/types";

/*
 * Whether a lot is still ours.
 *
 * Pinned because the first version of this rule read only `kind`, so every
 * signed contract came out "Vendido" — a lot with twenty cuotas left to pay
 * looked exactly like one bought outright that morning. Nothing on the Lotes
 * tab could tell an owner how much land the company still holds, which is the
 * question the column exists to answer.
 */

function holding(saleType: SaleType, status: ContractStatus = "active"): LotHolding {
  return {
    contractId: "c1",
    contractCode: "CT-2026-014",
    customerId: "cu1",
    kind: "contract",
    saleType,
    status,
    salePrice: cents(18_500_000),
    paidToDate: cents(0),
  };
}

function lot(held: LotHolding | null): Lot {
  return {
    id: "l1",
    code: "A-07",
    projectName: "Valle Verde",
    areaM2: 300,
    basePrice: cents(18_500_000),
    holding: held,
    archivedAt: null,
  };
}

describe("lotStatus", () => {
  it("calls a lot with nothing against it available", () => {
    assert.equal(lotStatus(lot(null)), "available");
  });

  it("calls a live crédito financiado, not vendido", () => {
    // The whole point: the customer is paying monthly and the land is still
    // ours until they finish.
    assert.equal(lotStatus(lot(holding("financed"))), "financed");
  });

  it("calls a contado sale vendido straight away", () => {
    // Settled at signing. There was never a balance to wait on.
    assert.equal(lotStatus(lot(holding("cash"))), "sold");
  });

  it("turns a crédito into vendido once it is paid off", () => {
    // Nothing left to collect, so it has become what a contado sale already
    // was — and it must stop being counted as land we hold.
    assert.equal(lotStatus(lot(holding("financed", "paid_off"))), "sold");
  });

  it("keeps a donation apart from a sale", () => {
    // Gone, but nobody bought it. Counting it as sold would turn a giveaway
    // into revenue on every screen that adds these up.
    assert.equal(lotStatus(lot(holding("donation"))), "donated");
  });

  it("calls a hold reserved whatever it was going to be paid with", () => {
    // A reservation has not been sold on any terms yet, so the terms get no
    // say — including the crédito a reservation is usually taken out for.
    for (const saleType of ["financed", "cash", "donation"] as const) {
      assert.equal(
        lotStatus(lot({ ...holding(saleType), kind: "reservation" })),
        "reserved",
      );
    }
  });
});
