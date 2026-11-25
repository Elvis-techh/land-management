import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { carriedInNote, paidMoneySentence } from "../src/features/contracts/paidMoneyText";
import type { MoneyView } from "../src/lib/money";
import type { ContractPaidMoney } from "../src/types";

/*
 * What a replaced contract says became of its money, and what the contract
 * that replaced it says arrived. The case: L 86,000 paid, L 54,000 moved to
 * the new contract as prima, L 32,000 to be given back.
 */

const HNL: MoneyView = { currency: "HNL", usdRate: 25 };
const plain = (text: string) => text.replace(/ /g, " ");

const carryover = {
  paymentId: "p-1",
  contractId: "c-2",
  code: "CT-2026-090-A1",
  amountCents: 5_400_000,
  on: "2026-11-05",
  type: "down_payment" as const,
};
const refund = (returnedOn: string | null) => ({
  id: "r-1",
  amountCents: 3_200_000,
  reason: "Se devuelve el resto.",
  recordedBy: "Gerencia",
  recordedAt: "2026-11-24T20:00:00.000Z",
  returnedOn,
  method: returnedOn ? ("cash" as const) : null,
  reference: null,
});

const sentence = (paidMoney: ContractPaidMoney | null, paid = 8_600_000) =>
  plain(paidMoneySentence(paidMoney, paid, HNL));

describe("what a replaced contract says became of its money", () => {
  it("keeps the old wording while nothing was decided", () => {
    assert.equal(sentence(null), "Lo pagado quedó como ingreso.");
    assert.equal(sentence(null, 0), "No se pagó nada con este contrato.");
  });

  it("names the traslado and the devolución still owed", () => {
    assert.equal(
      sentence({ carryovers: [carryover], refunds: [refund(null)], keptCents: 0 }),
      "L. 54,000 pasaron a CT-2026-090-A1 y L. 32,000 están por devolver.",
    );
  });

  it("says so once the money was given back", () => {
    assert.equal(
      sentence({ carryovers: [carryover], refunds: [refund("2026-12-01")], keptCents: 0 }),
      "L. 54,000 pasaron a CT-2026-090-A1 y L. 32,000 se devolvieron.",
    );
  });

  it("names what is still income when part was left undecided", () => {
    assert.equal(
      sentence({ carryovers: [carryover], refunds: [], keptCents: 3_200_000 }),
      "L. 54,000 pasaron a CT-2026-090-A1 y L. 32,000 quedan como ingreso.",
    );
  });

  it("reads right with only a devolución", () => {
    assert.equal(
      sentence({ carryovers: [], refunds: [refund(null)], keptCents: 5_400_000 }),
      "L. 32,000 está por devolver y L. 54,000 quedan como ingreso.",
    );
  });
});

describe("what the new contract says arrived from the old one", () => {
  it("keeps the old wording while nothing moved", () => {
    assert.equal(
      plain(carriedInNote(8_600_000, [], HNL)),
      "L. 86,000 · quedó como ingreso, no se abona a este precio",
    );
  });

  it("names the part that moved", () => {
    assert.equal(
      plain(carriedInNote(8_600_000, [carryover], HNL)),
      "L. 86,000 · L. 54,000 pasaron a este contrato",
    );
  });

  it("says all of it when all of it moved", () => {
    assert.equal(
      plain(carriedInNote(5_400_000, [carryover], HNL)),
      "L. 54,000 · todo pasó a este contrato",
    );
  });
});
