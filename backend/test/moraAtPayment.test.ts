import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ContractTerms } from "../src/lib/contracts.js";
import type { MoraAccount } from "../src/lib/mora.js";
import { changeRows, justBefore, moraChangeRefusal, oldestLate, planMoraChange } from "../src/lib/moraAtPayment.js";

/*
 * The mora changed in «Registrar un pago» (lib/moraAtPayment.ts): what rows a
 * change files, without the database. The routes are in
 * mora-at-payment.test.ts.
 */

/** L 1 = 100 centavos. */
const L = (amount: number) => Math.round(amount * 100);

/** Only what `planMoraChange` reads: the charges in order and what is owed of each. */
function account(charges: Array<[installment: number, amount: number, pending: number]>): MoraAccount {
  const list = charges.map(([installment, amount], index) => ({
    id: `mora:${installment}:${index}`,
    installment,
    incurredOn: `2026-10-0${index + 1}`,
    amountCents: L(amount),
    unpaidCents: L(10_000),
  }));
  const pendingByCharge = Object.fromEntries(
    charges
      .map(([, , pending], index) => [list[index]!.id, L(pending)] as const)
      .filter(([, pending]) => pending > 0),
  );
  const pending = charges.reduce((total, [, , owed]) => total + L(owed), 0);

  return {
    charges: list,
    splits: [],
    forgiven: [],
    chargedCents: 0,
    paidCents: 0,
    forgivenCents: 0,
    pendingCents: pending,
    pendingByCharge,
    pendingByInstallment: {},
    forgivenByCharge: {},
  };
}

describe("planMoraChange", () => {
  it("files nothing when the mora is left as it was", () => {
    assert.deepEqual(planMoraChange(account([[0, 500, 500]]), L(500), 1), { forgive: [], charge: null });
  });

  it("forgives from the oldest charge first, one «Perdonar» per cuota", () => {
    const owed = account([
      [0, 500, 500],
      [1, 300, 300],
      [2, 200, 200],
    ]);

    // L 1,000 owed, L 150 to stay: L 850 off, the prima's L 500 and L 300 of cuota 1, then L 50 of cuota 2.
    assert.deepEqual(planMoraChange(owed, L(150), 1), {
      forgive: [
        { installment: 0, amountCents: L(500) },
        { installment: 1, amountCents: L(300) },
        { installment: 2, amountCents: L(50) },
      ],
      charge: null,
    });
  });

  it("to zero: forgives everything still owed, never a charge already paid", () => {
    // The prima's L 500 was paid: only cuota 1's L 300 is owed.
    const owed = account([
      [0, 500, 0],
      [1, 300, 300],
    ]);

    assert.deepEqual(planMoraChange(owed, 0, 1), {
      forgive: [{ installment: 1, amountCents: L(300) }],
      charge: null,
    });
  });

  it("charges the difference on the oldest late cuota", () => {
    assert.deepEqual(planMoraChange(account([[2, 200, 200]]), L(700), 1), {
      forgive: [],
      charge: { installment: 1, amountCents: L(500) },
    });
  });

  it("«Cobrar mora» on a lot that owes none goes on its oldest late cuota", () => {
    assert.deepEqual(planMoraChange(undefined, L(250), 0), {
      forgive: [],
      charge: { installment: 0, amountCents: L(250) },
    });
  });

  it("with no late cuota, charges on the cuota of the newest mora still owed", () => {
    assert.deepEqual(
      planMoraChange(
        account([
          [1, 300, 300],
          [2, 200, 200],
        ]),
        L(600),
        null,
      ),
      { forgive: [], charge: { installment: 2, amountCents: L(100) } },
    );
  });

  it("refuses to charge a lot that is not late and owes no mora", () => {
    assert.ok("problem" in planMoraChange(undefined, L(100), null));
    assert.ok("problem" in planMoraChange(account([[1, 300, 0]]), L(100), null));
  });
});

describe("oldestLate", () => {
  const terms: ContractTerms = {
    saleType: "financed",
    salePriceCents: L(130_000),
    downPaymentCents: L(10_000),
    termMonths: 12,
    monthlyPaymentCents: L(10_000),
    dueDay: 5,
    signedOn: "2026-08-20",
    firstDueOn: "2026-09-05",
  };

  it("is the prima while it is not fully paid", () => {
    assert.deepEqual(oldestLate(terms, L(9_999), "2026-11-06", 5), { installment: 0, dueOn: "2026-08-20" });
  });

  it("is the first cuota past due and not fully paid", () => {
    // Prima and cuota 1 paid, cuota 2 (5 Oct) half paid.
    assert.deepEqual(oldestLate(terms, L(25_000), "2026-11-06", 5), { installment: 2, dueOn: "2026-10-05" });
  });

  it("counts a cuota falling due today as not late yet, with no grace days", () => {
    assert.equal(oldestLate(terms, L(30_000), "2026-11-05", 0), null);
    assert.deepEqual(oldestLate(terms, L(30_000), "2026-11-06", 0), { installment: 3, dueOn: "2026-11-05" });
  });

  it("waits out the grace days, until the day the automatic mora would be charged", () => {
    // Cuota 3 fell due on 5 Nov. With 5 days of grace the automatic mora comes on the 11th:
    // a «Cobrar mora» before then would be followed by that charge, mora twice.
    assert.equal(oldestLate(terms, L(30_000), "2026-11-06", 5), null);
    assert.equal(oldestLate(terms, L(30_000), "2026-11-10", 5), null);
    assert.deepEqual(oldestLate(terms, L(30_000), "2026-11-11", 5), { installment: 3, dueOn: "2026-11-05" });
    // The prima the same way, from the day it was signed.
    const signedLate = { ...terms, signedOn: "2026-11-03", dueDay: 3, firstDueOn: "2026-12-03" };
    assert.equal(oldestLate(signedLate, L(0), "2026-11-08", 5), null);
    assert.deepEqual(oldestLate(signedLate, L(0), "2026-11-09", 5), { installment: 0, dueOn: "2026-11-03" });
  });

  it("is null when everything due is paid", () => {
    assert.equal(oldestLate(terms, L(40_000), "2026-11-06", 5), null);
  });
});

describe("changeRows", () => {
  it("dates every row on the payment's day and puts the «Perdonar» rows just before the payment", () => {
    let next = 0;
    const paymentAt = "2026-11-06T15:00:00.000Z";
    const rows = changeRows(
      { forgive: [{ installment: 0, amountCents: L(500) }], charge: { installment: 1, amountCents: L(100) } },
      "2026-11-06",
      justBefore(paymentAt),
      () => `row-${(next += 1)}`,
    );

    assert.deepEqual(rows, {
      manual: [{ id: "row-1", installment: 1, incurredOn: "2026-11-06", amountCents: L(100) }],
      forgiveness: [
        {
          id: "row-2",
          installment: 0,
          forgivenOn: "2026-11-06",
          recordedAt: "2026-11-06T14:59:59.999Z",
          amountCents: L(500),
        },
      ],
    });
  });
});

describe("moraChangeRefusal: no receipt already issued changes (owner, 12 Nov 2026)", () => {
  const today = "2026-11-12";
  const refusal = (paidOn: string, latest: { paidOn: string; receiptCode: string | null } | null, raising: boolean) =>
    moraChangeRefusal({ paidOn, today, latest, raising });

  it("allows today, and an earlier day with no payment after it", () => {
    assert.equal(refusal(today, null, true), null);
    assert.equal(refusal(today, { paidOn: "2026-11-01", receiptCode: "A1" }, true), null);
    assert.equal(refusal("2026-04-30", null, true), null);
    assert.equal(refusal("2026-04-30", { paidOn: "2026-03-31", receiptCode: "A1" }, true), null);
  });

  it("refuses any change when a receipt is dated after the payment, and names it", () => {
    for (const raising of [true, false]) {
      assert.equal(
        refusal("2026-04-30", { paidOn: "2026-11-05", receiptCode: "QX7" }, raising),
        "Tiene un recibo del 5 nov (QX7), posterior a esta fecha: su mora solo se cambia en un pago " +
          "del 5 nov o después, para que ese recibo no cambie.",
      );
    }
    assert.match(refusal("2026-04-30", { paidOn: today, receiptCode: null }, false)!, /^Tiene un pago de hoy,.* en un pago de hoy,/);
  });

  it("on the same day as a receipt, allows less mora but not more", () => {
    assert.equal(refusal("2026-04-30", { paidOn: "2026-04-30", receiptCode: "QX7" }, false), null);
    assert.equal(
      refusal("2026-04-30", { paidOn: "2026-04-30", receiptCode: "QX7" }, true),
      "Ya tiene un recibo del 30 abr (QX7): cobrarle más mora ese mismo día cambiaría lo que ese recibo cobró. " +
        "Cóbrala en un pago de un día posterior.",
    );
    assert.match(refusal(today, { paidOn: today, receiptCode: "QX7" }, true)!, /^Ya tiene un recibo de hoy \(QX7\)/);
  });

  it("refuses a future date", () => {
    assert.equal(refusal("2026-11-13", null, false), "La mora no se cambia en un pago con fecha futura.");
  });
});
