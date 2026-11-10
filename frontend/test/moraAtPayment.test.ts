import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PaymentMoraCharge, PaymentMoraLot } from "../src/features/receipts/api";
import {
  DATE_FIELD,
  cuotaSentence,
  cuotaSentences,
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
  forgiven: L(0),
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
      "Cuota 1, venció el 25 ago: L. 500. Pasados 5 días de gracia, se cargó el 10 % de los L. 2,000 " +
        "que faltaban: L. 200 el 31 ago, L. 200 el 30 sep y L. 100 el 31 oct (llegó al máximo de L. 500 por cuota).",
      "Cuota 3, venció el 25 oct: L. 200. Pasados 5 días de gracia, el 31 oct se cargó el 10 % de los L. 2,000 " +
        "que faltaban.",
    ]);
  });

  it("a single charge cut short by the maximum, and one that was not", () => {
    assert.equal(
      plain(cuotaSentence([PRIMA], HNL)),
      "Prima, venció el 27 oct: L. 500. Pasados 5 días de gracia, el 2 nov se cargó " +
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
      "Cuota 1, venció el 25 ago: L. 150. Pasados 5 días de gracia, se cargó el 10 % de los L. 2,000 " +
        "que faltaban: L. 200 el 31 ago y L. 200 el 30 sep. Ya se pagaron L. 200 y se perdonaron L. 50.",
    );

    // One charge partly paid: its own amount has to be said, as the line's figure is what is left.
    assert.equal(
      plain(cuotaSentence([charge({ pending: L(100) })], HNL)),
      "Cuota 1, venció el 25 ago: L. 100. Pasados 5 días de gracia, el 31 ago se cargaron L. 200: " +
        "el 10 % de los L. 2,000 que faltaban. Ya se pagaron L. 100.",
    );
  });

  it("a fixed amount, a base that changed, one day of grace and none", () => {
    const fixed = { ...RULE, calculation: "fixed" as const, fixed: L(300), cap: null };
    const each = { amount: L(300), pending: L(300), rule: fixed };
    assert.match(
      plain(cuotaSentence([charge(each), charge({ ...each, incurredOn: "2026-09-30", repeat: true })], HNL)),
      /: L. 600\. Pasados 5 días de gracia, se cargó un monto fijo de L. 300: el 31 ago y el 30 sep\.$/,
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
    assert.match(graceOf(1), /L. 200\. Pasado 1 día de gracia, el 31 ago/);
    assert.match(graceOf(0), /L. 200\. El 31 ago se cargó el 10 %/);
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
    assert.equal(plain(cuotaSentence([manual], HNL)), "Cuota 2, venció el 25 sep: L. 500. Se cargó a mano el 4 nov.");

    assert.equal(
      plain(cuotaSentence([charge({ installment: 2, dueOn: "2026-09-25", incurredOn: "2026-10-01" }), manual], HNL)),
      "Cuota 2, venció el 25 sep: L. 700. Pasados 5 días de gracia, el 1 oct se cargaron L. 200: " +
        "el 10 % de los L. 2,000 que faltaban. Cargada a mano: L. 500 el 4 nov.",
    );

    const early = { ...manual, installment: 5, dueOn: "2026-12-25" };
    assert.equal(plain(cuotaSentence([early], HNL)), "Cuota 5: L. 500. Se cargó a mano el 4 nov.");
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
    assert.equal(six[4], "Y las cuotas 5 y 6: L. 200.");
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
