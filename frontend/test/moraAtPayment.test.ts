import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PaymentMoraCharge, PaymentMoraLot } from "../src/features/receipts/api";
import {
  DATE_FIELD,
  cuotaSentence,
  cuotaSentences,
  draftMora,
  moraBlocker,
  moraDateRefusal,
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
  forgiven: L(0),
  unpaid: L(30_000),
  manual: false,
  repeat: false,
  rule: { calculation: "percent", percent: 10, fixed: L(0), cap: L(500), graceDays: 5 },
};

const lot = (patch: Partial<PaymentMoraLot> = {}): PaymentMoraLot => ({
  contractId: "c1",
  carriesMora: true,
  on: "2026-11-06",
  latestPayment: { paidOn: "2026-10-01", receiptCode: "QX7" },
  pending: L(500),
  charges: [PRIMA],
  late: { installment: 0, dueOn: "2026-10-27" },
  ...patch,
});

/** The sentences with plain spaces: the form keeps "L." and its figure together with a no-break one. */
const plain = (text: string) => text.replace(/\u00a0/g, " ");

/** The test site's case 03 as the owner saw it (2026-11-09): L 2,000 cuotas, 10 % up to L 500, cuota 2 forgiven. */
const RULE = { calculation: "percent" as const, percent: 10, fixed: L(0), cap: L(500), graceDays: 5 };
const charge = (patch: Partial<PaymentMoraCharge>): PaymentMoraCharge => ({
  installment: 1,
  dueOn: "2026-08-25",
  incurredOn: "2026-08-31",
  amount: L(200),
  pending: L(200),
  forgiven: L(0),
  unpaid: L(2_000),
  manual: false,
  repeat: false,
  rule: RULE,
  ...patch,
});
const CUOTA_1 = [
  charge({}),
  charge({ incurredOn: "2026-09-30", repeat: true }),
  charge({ incurredOn: "2026-10-31", repeat: true, amount: L(100), pending: L(100) }),
];
const CUOTA_3 = [charge({ installment: 3, dueOn: "2026-10-25", incurredOn: "2026-10-31" })];

describe("why a lot has mora: a line per cuota", () => {
  it("the owner's case 03: says the maximum and that it was reached, and hides no charge", () => {
    // In the order the server sends them: by date, cuota 3's charge before cuota 1's last.
    const charges = [...CUOTA_1.slice(0, 2), CUOTA_3[0]!, CUOTA_1[2]!];
    assert.deepEqual(cuotaSentences(lot({ pending: L(700), charges }), HNL).map(plain), [
      "Cuota 1, venció el 25 ago: L. 500 por pagar. Pasados 5 días de gracia, se cargó el 10 % de los L. 2,000 " +
        "que faltaban: L. 200 el 31 ago, L. 200 el 30 sep y L. 100 el 31 oct (llegó al máximo de L. 500 por cuota).",
      "Cuota 3, venció el 25 oct: L. 200 por pagar. Pasados 5 días de gracia, el 31 oct se cargó el 10 % de los L. 2,000 " +
        "que faltaban.",
    ]);
  });

  it("a single charge cut short by the maximum, and one that was not", () => {
    assert.equal(
      plain(cuotaSentence([PRIMA], HNL)),
      "Prima, venció el 27 oct: L. 500 por pagar. Pasados 5 días de gracia, el 2 nov se cargó " +
        "el 10 % de los L. 30,000 que faltaban, hasta el máximo de L. 500 por cuota.",
    );

    const small = { ...PRIMA, amount: L(300), pending: L(300), unpaid: L(3_000) };
    assert.match(plain(cuotaSentence([small], HNL)), /se cargó el 10 % de los L. 3,000 que faltaban\.$/);
  });

  it("keeps the paid and forgiven charges in, so the figures add up", () => {
    const settled = [
      charge({ pending: L(0) }),
      charge({ incurredOn: "2026-09-30", repeat: true, pending: L(150), forgiven: L(50) }),
    ];
    assert.equal(
      plain(cuotaSentence(settled, HNL)),
      "Cuota 1, venció el 25 ago: L. 150 por pagar. Pasados 5 días de gracia, se cargó el 10 % de los L. 2,000 " +
        "que faltaban: L. 200 el 31 ago y L. 200 el 30 sep. Ya se pagaron L. 200 y se perdonaron L. 50.",
    );

    // One charge partly paid: its own amount has to be said, as the line's figure is what is left.
    assert.equal(
      plain(cuotaSentence([charge({ pending: L(100) })], HNL)),
      "Cuota 1, venció el 25 ago: L. 100 por pagar. Pasados 5 días de gracia, el 31 ago se cargaron L. 200: " +
        "el 10 % de los L. 2,000 que faltaban. Ya se pagaron L. 100.",
    );
  });

  it("a fixed amount, a base that changed, one day of grace and none", () => {
    const fixed = { ...RULE, calculation: "fixed" as const, fixed: L(300), cap: null };
    const each = { amount: L(300), pending: L(300), rule: fixed };
    assert.match(
      plain(cuotaSentence([charge(each), charge({ ...each, incurredOn: "2026-09-30", repeat: true })], HNL)),
      /: L. 600 por pagar\. Pasados 5 días de gracia, se cargó un monto fijo de L. 300: el 31 ago y el 30 sep\.$/,
    );

    const halfPaid = charge({
      incurredOn: "2026-09-30",
      repeat: true,
      amount: L(100),
      pending: L(100),
      unpaid: L(1_000),
    });
    assert.match(
      plain(cuotaSentence([charge({}), halfPaid], HNL)),
      /se cargó el 10 % de lo que faltaba: L. 200 el 31 ago \(de L. 2,000\) y L. 100 el 30 sep \(de L. 1,000\)\.$/,
    );

    const graceOf = (graceDays: number) => plain(cuotaSentence([charge({ rule: { ...RULE, graceDays } })], HNL));
    assert.match(graceOf(1), /L. 200 por pagar\. Pasado 1 día de gracia, el 31 ago/);
    assert.match(graceOf(0), /L. 200 por pagar\. El 31 ago se cargó el 10 %/);
  });

  it("says a mora put on by hand, alone or beside the rule's, and no «venció» before the cuota fell due", () => {
    const manual = charge({
      installment: 2,
      dueOn: "2026-09-25",
      incurredOn: "2026-11-04",
      amount: L(500),
      pending: L(500),
      manual: true,
      rule: null,
    });
    assert.equal(plain(cuotaSentence([manual], HNL)), "Cuota 2, venció el 25 sep: L. 500 por pagar. Se cargó a mano el 4 nov.");

    assert.equal(
      plain(cuotaSentence([charge({ installment: 2, dueOn: "2026-09-25", incurredOn: "2026-10-01" }), manual], HNL)),
      "Cuota 2, venció el 25 sep: L. 700 por pagar. Pasados 5 días de gracia, el 1 oct se cargaron L. 200: " +
        "el 10 % de los L. 2,000 que faltaban. Cargada a mano: L. 500 el 4 nov.",
    );

    const early = { ...manual, installment: 5, dueOn: "2026-12-25" };
    assert.equal(plain(cuotaSentence([early], HNL)), "Cuota 5: L. 500 por pagar. Se cargó a mano el 4 nov.");
  });

  it("puts the prima first, and past four cuotas sums the rest, but never a single one", () => {
    const cuotas = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        charge({ installment: count - index, amount: L(100), pending: L(100) }),
      );

    // The prima and four cuotas: five, so the fifth gets its own line rather than «Y la cuota 4».
    const five = cuotaSentences(lot({ charges: [...cuotas(4), PRIMA] }), HNL).map(plain);
    assert.equal(five.length, 5);
    assert.match(five[0]!, /^Prima,/);
    assert.match(five[1]!, /^Cuota 1,/);
    assert.ok(five.every((line) => !line.startsWith("Y ")));

    const six = cuotaSentences(lot({ charges: cuotas(6) }), HNL).map(plain);
    assert.equal(six.length, 5);
    assert.equal(six[4], "Y las cuotas 5 y 6: L. 200 por pagar.");
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

  it("allows an earlier day with no receipt after it (owner, 12 Nov 2026)", () => {
    assert.equal(
      moraBlocker({ ...base, paidOn: "2026-10-15", edits: { c1: { amount: "0", reason: "Migrado de Airtable" } } }),
      null,
    );
  });

  it("refuses a day before a receipt already issued, and sends the caret to the date", () => {
    const blocked = moraBlocker({
      ...base,
      paidOn: "2026-09-30",
      edits: { c1: { amount: "0", reason: "Migrado de Airtable" } },
    });
    assert.equal(blocked?.focus, DATE_FIELD);
    assert.equal(
      blocked!.message,
      "B-01: Tiene un recibo del 1 oct (QX7), posterior a esta fecha: su mora solo se cambia en un pago " +
        "del 1 oct o después, para que ese recibo no cambie. Cambia la fecha o deja la mora como estaba.",
    );
  });

  it("on the day of a receipt, refuses more mora but not less", () => {
    const edits = (amount: string) => ({ c1: { amount, reason: "Migrado de Airtable" } });
    assert.equal(moraBlocker({ ...base, paidOn: "2026-10-01", edits: edits("100") }), null);
    assert.match(
      moraBlocker({ ...base, paidOn: "2026-10-01", edits: edits("900") })!.message,
      /^B-01: Ya tiene un recibo del 1 oct \(QX7\): cobrarle más mora ese mismo día/,
    );
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

describe("moraDateRefusal: the server's rule, said before the save", () => {
  const TODAY = "2026-11-12";
  const on = (latestPayment: PaymentMoraLot["latestPayment"]) => ({ latestPayment });

  it("matches the server's words", () => {
    // backend/test/moraAtPayment.test.ts checks the same sentences.
    assert.equal(
      moraDateRefusal(on({ paidOn: "2026-11-05", receiptCode: "QX7" }), "2026-04-30", TODAY, false),
      "Tiene un recibo del 5 nov (QX7), posterior a esta fecha: su mora solo se cambia en un pago " +
        "del 5 nov o después, para que ese recibo no cambie.",
    );
    assert.equal(
      moraDateRefusal(on({ paidOn: "2026-04-30", receiptCode: "QX7" }), "2026-04-30", TODAY, true),
      "Ya tiene un recibo del 30 abr (QX7): cobrarle más mora ese mismo día cambiaría lo que ese recibo cobró. " +
        "Cóbrala en un pago de un día posterior.",
    );
    assert.equal(moraDateRefusal(on(null), "2026-11-13", TODAY, false), "La mora no se cambia en un pago con fecha futura.");
  });

  it("says «de hoy» for today's receipt, and «un pago» for money with no receipt", () => {
    assert.match(
      moraDateRefusal(on({ paidOn: TODAY, receiptCode: null }), "2026-04-30", TODAY, false)!,
      /^Tiene un pago de hoy, posterior a esta fecha: su mora solo se cambia en un pago de hoy,/,
    );
  });

  it("allows a lot with no payments, or none on or after the date", () => {
    assert.equal(moraDateRefusal(on(null), "2026-04-30", TODAY, true), null);
    assert.equal(moraDateRefusal(on({ paidOn: "2026-04-29", receiptCode: "A" }), "2026-04-30", TODAY, true), null);
  });
});
