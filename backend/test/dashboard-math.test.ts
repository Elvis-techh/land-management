import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ContractTerms } from "../src/lib/contracts.js";
import { assessContract, outstandingInstallments } from "../src/lib/contracts.js";
import {
  Tally,
  expectedByMonth,
  isBehind,
  monthEnd,
  monthOf,
  monthsAfter,
  monthsEndingAt,
  monthsOfStock,
  shiftMonth,
} from "../src/lib/dashboard.js";

/** L 1 = 100 centavos, as everywhere else in the app. */
const lempiras = (amount: number) => Math.round(amount * 100);

/** A typical financed sale: L 185,000, L 25,000 down, 24 months at L 6,700, due the 5th. */
const financed: ContractTerms = {
  saleType: "financed",
  salePriceCents: lempiras(185_000),
  downPaymentCents: lempiras(25_000),
  termMonths: 24,
  monthlyPaymentCents: lempiras(6_700),
  dueDay: 5,
  signedOn: "2026-01-15",
};

describe("months", () => {
  it("finds the last day of a month, February and leap years included", () => {
    assert.equal(monthEnd("2026-08"), "2026-08-31");
    assert.equal(monthEnd("2026-04"), "2026-04-30");
    assert.equal(monthEnd("2026-02"), "2026-02-28");
    assert.equal(monthEnd("2028-02"), "2028-02-29");
    assert.equal(monthEnd("2026-12"), "2026-12-31");
  });

  it("shifts across a year boundary in both directions", () => {
    assert.equal(shiftMonth("2026-01", -1), "2025-12");
    assert.equal(shiftMonth("2026-12", 1), "2027-01");
    assert.equal(shiftMonth("2026-08", -14), "2025-06");
  });

  it("builds a window that ends on the month asked for", () => {
    const window = monthsEndingAt("2026-08", 12);

    assert.equal(window.length, 12);
    assert.equal(window[0], "2025-09");
    assert.equal(window.at(-1), "2026-08");
  });

  it("starts the projection the month AFTER the one being reported", () => {
    // Off by one here would double-count the current month: once as collected
    // and again as money still to come.
    assert.deepEqual(monthsAfter("2026-11", 3), ["2026-12", "2027-01", "2027-02"]);
  });

  it("reads the month off a date and off a timestamp alike", () => {
    assert.equal(monthOf("2026-08-31"), "2026-08");
    assert.equal(monthOf("2026-08-26T15:02:23.451Z"), "2026-08");
    // SQLite's own default format, which the audit and receipt rows carry.
    assert.equal(monthOf("2026-08-26 15:02:23"), "2026-08");
  });
});

describe("what a contract is scheduled to bring in", () => {
  it("puts the prima in the signing month and each cuota in its own", () => {
    const expected = expectedByMonth(financed);

    // Signed 15 January: the prima is due then, and the first cuota on 5 Feb.
    assert.equal(expected.get("2026-01"), lempiras(25_000));
    assert.equal(expected.get("2026-02"), lempiras(6_700));
    assert.equal(expected.get("2027-01"), lempiras(6_700));
  });

  it("sums to the sale price and not a centavo more", () => {
    const total = [...expectedByMonth(financed).values()].reduce((sum, value) => sum + value, 0);

    // The last installment absorbs the rounding, so prima + cuotas is exactly
    // the price. A schedule that summed to monthly × months would quietly
    // report income that was never agreed to.
    assert.equal(total, financed.salePriceCents);
  });

  it("expects the whole price in one month for a cash sale", () => {
    const cash: ContractTerms = {
      saleType: "cash",
      salePriceCents: lempiras(90_000),
      downPaymentCents: 0,
      termMonths: null,
      monthlyPaymentCents: null,
      dueDay: null,
      signedOn: "2026-03-20",
    };

    assert.deepEqual([...expectedByMonth(cash)], [["2026-03", lempiras(90_000)]]);
  });

  it("expects nothing, ever, from a donation", () => {
    const donation: ContractTerms = {
      saleType: "donation",
      salePriceCents: 0,
      downPaymentCents: 0,
      termMonths: null,
      monthlyPaymentCents: null,
      dueDay: null,
      signedOn: "2026-03-20",
    };

    assert.equal(expectedByMonth(donation).size, 0);
  });

  it("leaves out a prima of zero rather than recording an empty month", () => {
    const noPrima = { ...financed, downPaymentCents: 0 };

    // January has no installment either — the first is 5 February — so the
    // month should be absent, not present with a zero somebody has to filter.
    assert.equal(expectedByMonth(noPrima).has("2026-01"), false);
  });

  it("agrees with the health arithmetic about what was due by a date", () => {
    // The Panel General sums this map to ask "what should have arrived by the
    // end of August". The Contratos tab asks lib/contracts.ts the same question
    // a different way. If these two ever disagree, one screen is lying.
    const expected = expectedByMonth(financed);
    let throughAugust = 0;

    for (const [month, amount] of expected) {
      if (month <= "2026-08") {
        throughAugust += amount;
      }
    }

    // Nothing paid, assessed on the month's last day with no grace to muddy it:
    // arrears then equal everything that was due.
    const health = assessContract(financed, 0, "2026-08-31");

    // The grace period means arrears lag by five days, so compare against the
    // graced position: due through 26 August is the same set of installments.
    assert.equal(health.arrearsCents, throughAugust);
  });
});

describe("installments still owing", () => {
  it("counts the whole schedule when nothing has been paid", () => {
    assert.equal(outstandingInstallments(financed, 0).length, 24);
  });

  it("ignores the prima, which is not installment one", () => {
    // Exactly the prima paid: all 24 installments are still ahead.
    const outstanding = outstandingInstallments(financed, lempiras(25_000));

    assert.equal(outstanding.length, 24);
    assert.equal(outstanding[0]?.number, 1);
    assert.equal(outstanding[0]?.amountCents, lempiras(6_700));
  });

  it("asks for the difference on a part-paid installment, not the whole amount", () => {
    const outstanding = outstandingInstallments(financed, lempiras(25_000 + 4_000));

    assert.equal(outstanding[0]?.number, 1);
    assert.equal(outstanding[0]?.amountCents, lempiras(2_700));
    // The one after it is untouched.
    assert.equal(outstanding[1]?.amountCents, lempiras(6_700));
  });

  it("empties once the contract is paid off", () => {
    assert.equal(outstandingInstallments(financed, financed.salePriceCents).length, 0);
  });

  it("still reports the last installments as owed after a big early payment", () => {
    // Three cuotas paid at once. The count is what tells the Panel General a
    // contract is about to finish, so it must not be fooled by the lump.
    const outstanding = outstandingInstallments(financed, lempiras(25_000 + 6_700 * 3));

    assert.equal(outstanding.length, 21);
    assert.equal(outstanding[0]?.number, 4);
  });
});

describe("who counts as behind", () => {
  it("keeps por vencer out of the debtor lists", () => {
    // Amber is a reason to make a phone call, not a reason to appear on a list
    // of debtors. Getting this wrong reports a healthy book as a failing one
    // every month, five days after the due day.
    assert.equal(isBehind("current"), false);
    assert.equal(isBehind("due_soon"), false);
    assert.equal(isBehind("overdue"), true);
    assert.equal(isBehind("at_risk"), true);
  });
});

describe("months of stock", () => {
  it("projects from the trailing sale rate", () => {
    // 12 lots left, 6 sold in 6 months — one a month, so a year of stock.
    assert.equal(monthsOfStock(12, 6, 6), 12);
  });

  it("refuses to answer when nothing has sold", () => {
    // Not zero. A project that sold nothing is not a project that sells out
    // today, and a 0 on the screen would say exactly that.
    assert.equal(monthsOfStock(12, 0, 6), null);
  });

  it("refuses to answer when there is nothing left to sell", () => {
    assert.equal(monthsOfStock(0, 6, 6), null);
  });
});

describe("Tally", () => {
  it("starts every key at zero rather than at undefined", () => {
    const tally = new Tally<string>();

    tally.add("2026-08", 500);
    tally.add("2026-08", 250);

    assert.equal(tally.get("2026-08"), 750);
    // The case this class exists for: a month nobody paid in has to be 0, not
    // NaN, or the whole chart renders blank instead of empty.
    assert.equal(tally.get("2026-07"), 0);
  });
});
