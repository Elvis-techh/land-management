import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PAYMENT_TYPE_OPTIONS,
  outstandingDownPayment,
  paymentTypeLabel,
  paysOffEarly,
  sharedPaymentType,
  suggestPaymentType,
  suggestPaymentTypeFor,
} from "../src/features/receipts/paymentType";

/*
 * The rule behind the Tipo the receipt form fills in for you.
 *
 * Worth pinning because it is a default nobody looks at: the whole point of
 * the column is that in the ordinary case the user reads "Cuota", agrees, and
 * moves on. A wrong default that nobody notices is a contract whose prima
 * reads as unpaid for the rest of its life — `downPaymentPaid` is summed from
 * exactly this field.
 */

/** A financed contract with the prima agreed at L 25,000 and none of it paid. */
const financed = {
  saleType: "financed" as const,
  terms: { downPayment: 2_500_000 },
  downPaymentPaid: 0,
};

describe("suggestPaymentType", () => {
  it("calls it a prima while any of the prima is still owed", () => {
    assert.equal(suggestPaymentType(financed), "down_payment");
  });

  it("still calls it a prima when only part of it has arrived", () => {
    assert.equal(
      suggestPaymentType({ ...financed, downPaymentPaid: 2_499_900 }),
      "down_payment",
    );
  });

  it("moves to cuota the moment the prima is settled", () => {
    assert.equal(suggestPaymentType({ ...financed, downPaymentPaid: 2_500_000 }), "installment");
  });

  it("treats an overpaid prima as settled rather than as owing a negative", () => {
    assert.equal(suggestPaymentType({ ...financed, downPaymentPaid: 3_000_000 }), "installment");
  });

  it("calls it a cuota when the contract agreed no prima at all", () => {
    assert.equal(
      suggestPaymentType({ ...financed, terms: { downPayment: 0 } }),
      "installment",
    );
  });

  /*
   * A cash sale is settled at signing and has no schedule, so it has no cuotas
   * to be one of — see buildSchedule in the backend. "Cuota" there names an
   * installment that exists nowhere in the contract.
   */
  it("calls a payment on a contract with no schedule a pago total", () => {
    assert.equal(
      suggestPaymentType({ ...financed, saleType: "cash", terms: { downPayment: 0 } }),
      "full_payment",
    );
  });

  it("puts the prima ahead of the sale type when one was agreed and is unpaid", () => {
    assert.equal(suggestPaymentType({ ...financed, saleType: "cash" }), "down_payment");
  });
});

/*
 * "Pago total" by the calendar: the payment clears the balance before the last
 * cuota's own period begins. In that period, or later, it is the last cuota.
 */
describe("suggestPaymentTypeFor", () => {
  /**
   * A 6-cuota contract due on the 5th, July to December 2026: the last cuota's
   * period begins the day after 5 November. Prima settled, L 5,000 left.
   */
  const paying = {
    ...financed,
    downPaymentPaid: 2_500_000,
    balance: 500_000,
    earlyPayoffThrough: "2026-11-05",
  };

  it("calls it a pago total when the balance is cleared before the last cuota's period", () => {
    // The case from the site: only the rest of the last cuota is left, but in
    // October, two months before it falls due.
    assert.equal(suggestPaymentTypeFor(paying, 500_000, "2026-10-15"), "full_payment");
  });

  it("still calls it a pago total on the second-to-last due date itself", () => {
    assert.equal(suggestPaymentTypeFor(paying, 500_000, "2026-11-05"), "full_payment");
  });

  it("keeps it a cuota once the last cuota's period has begun", () => {
    assert.equal(suggestPaymentTypeFor(paying, 500_000, "2026-11-06"), "installment");
    assert.equal(suggestPaymentTypeFor(paying, 500_000, "2026-12-05"), "installment");
  });

  it("keeps it a cuota when the last cuota is paid late", () => {
    assert.equal(suggestPaymentTypeFor(paying, 500_000, "2027-01-20"), "installment");
  });

  it("counts an amount over the balance as clearing it too", () => {
    assert.equal(suggestPaymentTypeFor(paying, 900_000, "2026-10-15"), "full_payment");
  });

  it("keeps the contract's own type when the amount does not clear the balance", () => {
    assert.equal(suggestPaymentTypeFor(paying, 499_999, "2026-10-15"), "installment");
  });

  it("calls it a pago total when the whole price is paid early while the prima is still owed", () => {
    const primaOwed = { ...financed, balance: 16_000_000, earlyPayoffThrough: "2027-05-05" };

    assert.equal(suggestPaymentTypeFor(primaOwed, 16_000_000, "2026-10-15"), "full_payment");
    assert.equal(suggestPaymentTypeFor(primaOwed, 2_500_000, "2026-10-15"), "down_payment");
  });

  it("never calls it early on a contract with fewer than two cuotas", () => {
    assert.equal(paysOffEarly({ balance: 500_000, earlyPayoffThrough: null }, 500_000, "2026-10-15"), false);
  });

  it("says nothing about an empty amount or a missing date", () => {
    assert.equal(paysOffEarly(paying, 0, "2026-10-15"), false);
    assert.equal(paysOffEarly(paying, 500_000, ""), false);
  });
});

describe("outstandingDownPayment", () => {
  it("is what is left of the agreed prima", () => {
    assert.equal(outstandingDownPayment({ ...financed, downPaymentPaid: 1_000_000 }), 1_500_000);
  });

  it("is zero, never negative, once more than the prima has been paid", () => {
    assert.equal(outstandingDownPayment({ ...financed, downPaymentPaid: 3_000_000 }), 0);
  });
});

describe("PAYMENT_TYPE_OPTIONS", () => {
  /* The picker in "Corregir transacción" offers these four, in this order. A
     type recordable here but not correctable there would be a trap. */
  it("offers the same four types the correction dialog does", () => {
    assert.deepEqual(
      PAYMENT_TYPE_OPTIONS.map((entry) => entry.value),
      ["down_payment", "installment", "full_payment", "adjustment"],
    );
  });
});

describe("paymentTypeLabel", () => {
  it("names the four the form can record", () => {
    assert.equal(paymentTypeLabel("down_payment"), "Prima");
    assert.equal(paymentTypeLabel("installment"), "Cuota");
  });

  /* `Transaction.type` is a plain string off the wire and the schema allows a
     fifth value. A blank chip would read as "this payment has no type". */
  it("shows the stored word for a type it has never heard of", () => {
    assert.equal(paymentTypeLabel("reversal"), "reversal");
  });
});

/*
 * What the "Tipo" field at the top of "Nueva transacción" is allowed to say.
 *
 * The field sits in the top grid for a receipt of one lot or of five, which it
 * can only do because it reads the lines rather than deciding for them. The
 * case that matters is the last one: with lots on different types there is no
 * single true answer, and inventing one would file a prima as a cuota in the
 * field `downPaymentPaid` is summed from.
 */
describe("sharedPaymentType", () => {
  it("gives the type when a single lot is the whole receipt", () => {
    assert.equal(sharedPaymentType(["down_payment"]), "down_payment");
  });

  it("gives the type when every lot is on it", () => {
    assert.equal(sharedPaymentType(["installment", "installment", "installment"]), "installment");
  });

  it("refuses to name one when the lots disagree", () => {
    // The receipt this whole feature exists for: a prima on the lot bought
    // last month, a cuota on the first. The field shows "Varios".
    assert.equal(sharedPaymentType(["down_payment", "installment"]), null);
  });

  it("refuses on a disagreement anywhere in the list, not just the front", () => {
    assert.equal(sharedPaymentType(["installment", "installment", "adjustment"]), null);
  });

  it("has no answer for no lots at all", () => {
    // No customer chosen yet. The form supplies its own opening default.
    assert.equal(sharedPaymentType([]), null);
  });
});
