import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PaymentMoraCharge, PaymentMoraLot } from "../src/features/receipts/api";
import {
  DATE_FIELD,
  chargeSentence,
  chargeSentences,
  draftMora,
  moraBlocker,
  moraFieldId,
  moraReasonFieldId,
  shortDate,
} from "../src/features/receipts/moraAtPayment";
import { amountFieldId } from "../src/features/receipts/receiptBlocker";
import type { MoneyView } from "../src/lib/money";
import { cents } from "../src/lib/money";

/*
 * The mora under each lot in «Registrar un pago»: the sentence that says why,
 * and what stops a receipt whose mora was changed. The owner's answers of
 * 2026-11-06.
 */

const HNL: MoneyView = { currency: "HNL", usdRate: 25 };
const L = (amount: number) => cents(Math.round(amount * 100));

/** The case the owner hit: a L 30,000 prima, 10 % up to L 500, 5 days of grace. */
const PRIMA: PaymentMoraCharge = {
  installment: 0,
  dueOn: "2026-10-27",
  incurredOn: "2026-11-02",
  amount: L(500),
  pending: L(500),
  unpaid: L(30_000),
  manual: false,
  repeat: false,
  rule: { calculation: "percent", percent: 10, fixed: L(0), cap: L(500), graceDays: 5 },
};

const lot = (patch: Partial<PaymentMoraLot> = {}): PaymentMoraLot => ({
  contractId: "c1",
  carriesMora: true,
  pending: L(500),
  charges: [PRIMA],
  late: { installment: 0, dueOn: "2026-10-27" },
  ...patch,
});

describe("why a lot has mora", () => {
  it("says the cuota, when it fell due, the grace days and the rule, and that the maximum applied", () => {
    assert.equal(
      chargeSentence(PRIMA, HNL),
      "La prima venció el 27 oct; pasados 5 días de gracia, el 2 nov se cargaron L. 500 " +
        "(10 % de los L. 30,000 que faltaban, con el máximo por cuota).",
    );
  });

  it("leaves the maximum out when it did not cut the amount", () => {
    const small = { ...PRIMA, amount: L(300), pending: L(300), unpaid: L(3_000) };
    assert.match(chargeSentence(small, HNL), /\(10 % de los L. 3,000 que faltaban\)\.$/);
  });

  it("says a monthly repeat, a fixed amount, one day of grace and what is left to pay", () => {
    const repeat = {
      ...PRIMA,
      installment: 3,
      incurredOn: "2026-12-02",
      repeat: true,
      pending: L(200),
      rule: { ...PRIMA.rule!, calculation: "fixed" as const, fixed: L(500), cap: null },
    };
    assert.equal(
      chargeSentence(repeat, HNL),
      "La cuota 3 seguía atrasada: el 2 dic se cargaron otra vez L. 500 (monto fijo). " +
        "Quedan L. 200 por pagar.",
    );

    const oneDay = { ...PRIMA, rule: { ...PRIMA.rule!, graceDays: 1 } };
    assert.match(chargeSentence(oneDay, HNL), /; pasados 1 día de gracia, el 2 nov/);

    const noGrace = { ...PRIMA, rule: { ...PRIMA.rule!, graceDays: 0 } };
    assert.match(chargeSentence(noGrace, HNL), /^La prima venció el 27 oct; el 2 nov se cargaron/);
  });

  it("says a mora put on by hand", () => {
    const manual = { ...PRIMA, installment: 2, manual: true, rule: null, incurredOn: "2026-11-04" };
    assert.equal(chargeSentence(manual, HNL), "La cuota 2: L. 500 cargados a mano el 4 nov.");
  });

  it("sums the charges past the third in one line", () => {
    const charges = [1, 2, 3, 4, 5].map((month) => ({ ...PRIMA, repeat: month > 1, pending: L(100) }));
    const lines = chargeSentences(lot({ charges }), HNL);

    assert.equal(lines.length, 4);
    assert.equal(lines[3], "Y 2 cargos más: L. 200.");
  });

  it("writes a date as day and month", () => {
    assert.equal(shortDate("2026-11-02"), "2 nov");
    assert.equal(shortDate("2026-01-15"), "15 ene");
  });
});

describe("what goes with the receipt line", () => {
  it("nothing while the mora is as it was or unreadable", () => {
    assert.equal(draftMora(lot(), { amount: "500.00", reason: "" }), undefined);
    assert.equal(draftMora(lot(), { amount: "", reason: "" }), undefined);
    assert.equal(draftMora(lot(), undefined), undefined);
  });

  it("the mora to owe and the reason, once changed", () => {
    assert.deepEqual(draftMora(lot(), { amount: "0", reason: "  Migrado de Airtable  " }), {
      amountCents: 0,
      reason: "Migrado de Airtable",
    });
    assert.deepEqual(draftMora(lot({ pending: L(0), charges: [] }), { amount: "250", reason: "x" }), {
      amountCents: 25_000,
      reason: "x",
    });
  });
});

describe("what stops a receipt whose mora was changed", () => {
  const TODAY = "2026-11-06";
  const base = {
    lots: [{ id: "c1", code: "B-01" }],
    mora: { c1: lot() },
    receiving: new Set(["c1"]),
    paidOn: TODAY,
    today: TODAY,
  };

  it("nothing when no mora was touched, or it was put back as it was", () => {
    assert.equal(moraBlocker({ ...base, edits: {} }), null);
    assert.equal(moraBlocker({ ...base, edits: { c1: { amount: "500", reason: "" } } }), null);
  });

  it("asks for a reason only when the mora changed", () => {
    assert.deepEqual(moraBlocker({ ...base, edits: { c1: { amount: "0", reason: "corto" } } }), {
      message: "Escribe por qué cambias la mora de B-01 (al menos 10 caracteres).",
      focus: moraReasonFieldId("c1"),
    });
    assert.equal(moraBlocker({ ...base, edits: { c1: { amount: "0", reason: "Migrado de Airtable" } } }), null);
  });

  it("refuses another day than today, and sends the caret to the date", () => {
    const blocked = moraBlocker({
      ...base,
      paidOn: "2026-11-05",
      edits: { c1: { amount: "0", reason: "Migrado de Airtable" } },
    });
    assert.equal(blocked?.focus, DATE_FIELD);
    assert.match(blocked!.message, /solo se cambia en un pago con la fecha de hoy/);
  });

  it("refuses a change on a lot that receives nothing", () => {
    const blocked = moraBlocker({
      ...base,
      receiving: new Set(),
      edits: { c1: { amount: "0", reason: "Migrado de Airtable" } },
    });
    assert.equal(blocked?.focus, amountFieldId("c1"));
  });

  it("asks for a figure when the box is empty", () => {
    assert.deepEqual(moraBlocker({ ...base, edits: { c1: { amount: "", reason: "" } } }), {
      message: "Escribe la mora que se cobra a B-01, o 0 para no cobrarla.",
      focus: moraFieldId("c1"),
    });
  });
});
