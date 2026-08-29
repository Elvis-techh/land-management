import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_ROUNDING_STEP_CENTS, splitEvenly } from "../src/lib/allocation.js";
import type { ContractTerms } from "../src/lib/contracts.js";
import { addMonthsOnDay, assessContract, buildSchedule, firstDueDate } from "../src/lib/contracts.js";

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

describe("due dates", () => {
  it("puts the first installment one whole month after signing, on the due day", () => {
    // Signed 15 January, due day the 5th: the first payment is 5 February, not
    // three weeks after the customer handed over the prima.
    assert.equal(firstDueDate(financed), "2026-02-05");
  });

  it("honours a negotiated first due date over the default", () => {
    assert.equal(firstDueDate({ ...financed, firstDueOn: "2026-04-05" }), "2026-04-05");
  });

  it("clamps a due day to months that are too short to have one", () => {
    // A contract due on the 31st still falls due in February, on the last day.
    assert.equal(addMonthsOnDay("2026-01-31", 1, 31), "2026-02-28");
    assert.equal(addMonthsOnDay("2028-01-31", 1, 31), "2028-02-29");
    assert.equal(addMonthsOnDay("2026-01-31", 3, 31), "2026-04-30");
  });

  it("rolls the year over without help", () => {
    assert.equal(addMonthsOnDay("2026-11-05", 3, 5), "2027-02-05");
  });
});

describe("the schedule", () => {
  it("has one installment per agreed month", () => {
    assert.equal(buildSchedule(financed).length, 24);
  });

  it("sums to exactly the financed amount, with the last installment absorbing the rounding", () => {
    const schedule = buildSchedule(financed);
    const total = schedule.reduce((sum, installment) => sum + installment.amountCents, 0);

    // L 160,000 financed over 24 months of L 6,700 is L 160,800 — L 800 too
    // much. The last installment is short by exactly that, so the schedule
    // matches the contract instead of the multiplication.
    assert.equal(total, lempiras(160_000));
    assert.equal(schedule[22]!.amountCents, lempiras(6_700));
    assert.equal(schedule[23]!.amountCents, lempiras(5_900));
  });

  it("gives a cash sale and a donation no schedule at all", () => {
    const cash: ContractTerms = {
      saleType: "cash",
      salePriceCents: lempiras(185_000),
      downPaymentCents: 0,
      termMonths: null,
      monthlyPaymentCents: null,
      dueDay: null,
      signedOn: "2026-01-15",
    };

    assert.deepEqual(buildSchedule(cash), []);
    assert.deepEqual(buildSchedule({ ...cash, saleType: "donation", salePriceCents: 0 }), []);
  });
});

describe("payment health", () => {
  /** Everything owed up to and including the given date, paid on time. */
  const paidThrough = (installments: number) =>
    financed.downPaymentCents + installments * lempiras(6_700);

  it("is current mid-cycle for a customer who has paid every installment due", () => {
    // 20 March: the prima plus February and March are in, and April is still
    // three weeks away.
    const report = assessContract(financed, paidThrough(2), "2026-03-20");

    assert.equal(report.status, "current");
    assert.equal(report.arrearsCents, 0);
    assert.equal(report.monthsBehind, 0);
    assert.equal(report.nextDueOn, "2026-04-05");
  });

  it("says an installment is due on the day it falls due, without calling it late", () => {
    const report = assessContract(financed, paidThrough(2), "2026-04-05");

    assert.equal(report.status, "due_soon");
    assert.equal(report.arrearsCents, 0);
    assert.equal(report.nextDueOn, "2026-04-05");
    assert.equal(report.nextDueAmountCents, lempiras(6_700));
  });

  it("does not call a customer late during the five-day grace period", () => {
    // The April installment was due on the 5th and it is now the 9th. Unpaid,
    // but inside the grace the owner agreed to — so it is worth a reminder and
    // is not yet a debt. Green would say there is nothing to do, which is what
    // the grace period is for: a call, not a late notice.
    const report = assessContract(financed, paidThrough(2), "2026-04-09");

    assert.equal(report.status, "due_soon");
    assert.equal(report.arrearsCents, 0);
    assert.equal(report.monthsBehind, 0);
  });

  it("calls it overdue the day after the grace runs out", () => {
    const report = assessContract(financed, paidThrough(2), "2026-04-11");

    assert.equal(report.status, "overdue");
    assert.equal(report.monthsBehind, 1);
    assert.equal(report.arrearsCents, lempiras(6_700));
  });

  it("escalates to at risk at two months behind", () => {
    const report = assessContract(financed, paidThrough(2), "2026-05-11");

    assert.equal(report.status, "at_risk");
    assert.equal(report.monthsBehind, 2);
    assert.equal(report.arrearsCents, lempiras(13_400));
  });

  it("warns that an installment is coming before it is missed", () => {
    // 1 April, everything due so far is paid, and the 5th is a week away.
    const report = assessContract(financed, paidThrough(2), "2026-04-01");

    assert.equal(report.status, "due_soon");
    assert.equal(report.nextDueOn, "2026-04-05");
  });

  it("counts a customer who paid two months at once as being ahead, not behind", () => {
    // 5 March: February, March and April are all in, plus the prima.
    const report = assessContract(financed, paidThrough(3), "2026-03-05");

    assert.equal(report.status, "current");
    assert.equal(report.monthsAhead, 1);
    assert.equal(report.monthsBehind, 0);
    // And the next thing owed is May, not the April they already covered.
    assert.equal(report.nextDueOn, "2026-05-05");
  });

  it("asks a part-paid installment for the difference, not for the whole amount", () => {
    const report = assessContract(financed, paidThrough(2) + lempiras(2_700), "2026-04-01");

    assert.equal(report.nextDueOn, "2026-04-05");
    assert.equal(report.nextDueAmountCents, lempiras(4_000));
  });

  it("does not announce that paying exactly on the due date is paying ahead", () => {
    // The trap the two expectations exist to avoid: on the 6th the March
    // installment is inside its grace, so measuring "ahead" against the graced
    // figure would report a month in advance every single month.
    const report = assessContract(financed, paidThrough(2), "2026-03-06");

    assert.equal(report.monthsAhead, 0);
    assert.equal(report.status, "current");
  });

  it("reports a settled contract with no balance and no next due date", () => {
    const report = assessContract(financed, financed.salePriceCents, "2026-06-11");

    assert.equal(report.settled, true);
    assert.equal(report.balanceCents, 0);
    assert.equal(report.arrearsCents, 0);
    assert.equal(report.nextDueOn, null);
  });

  it("never reports a negative balance, even when a customer overpays", () => {
    const report = assessContract(financed, financed.salePriceCents + lempiras(5_000), "2026-06-11");

    assert.equal(report.balanceCents, 0);
    assert.equal(report.settled, true);
  });

  it("treats an unpaid cash sale as one overdue debt, not months of arrears", () => {
    const cash: ContractTerms = {
      saleType: "cash",
      salePriceCents: lempiras(185_000),
      downPaymentCents: 0,
      termMonths: null,
      monthlyPaymentCents: null,
      dueDay: null,
      signedOn: "2026-01-15",
    };

    const report = assessContract(cash, 0, "2026-03-01");

    assert.equal(report.status, "overdue");
    assert.equal(report.monthsBehind, 1);
    assert.equal(report.arrearsCents, lempiras(185_000));
  });

  it("never expects anything of a donation", () => {
    const donation: ContractTerms = {
      saleType: "donation",
      salePriceCents: 0,
      downPaymentCents: 0,
      termMonths: null,
      monthlyPaymentCents: null,
      dueDay: null,
      signedOn: "2026-01-15",
    };

    const report = assessContract(donation, 0, "2030-01-01");

    assert.equal(report.status, "current");
    assert.equal(report.balanceCents, 0);
    assert.equal(report.settled, true);
  });
});

describe("splitting one payment across a purchase", () => {
  const threeLots = (balance: number) => [
    { contractId: "a", code: "CT-2026-001", balanceCents: lempiras(balance) },
    { contractId: "b", code: "CT-2026-002", balanceCents: lempiras(balance) },
    { contractId: "c", code: "CT-2026-003", balanceCents: lempiras(balance) },
  ];

  it("rounds to whole hundreds and gives one lot the difference", () => {
    // L 25,000 over three lots is L 8,333.33 each, which nobody writes on a
    // receipt. This is the split done by hand: 8,400 / 8,300 / 8,300.
    const result = splitEvenly(lempiras(25_000), threeLots(100_000));

    assert.equal(result.unallocatedCents, 0);
    assert.deepEqual(
      result.allocations.map((line) => line.amountCents).sort((a, b) => a - b),
      [lempiras(8_300), lempiras(8_300), lempiras(8_400)],
    );
  });

  it("evens itself out over the months without tracking whose turn it is", () => {
    // First payment: all three lots are level, so the extra goes to the lowest
    // contract number.
    const first = splitEvenly(lempiras(25_000), threeLots(100_000));
    const firstExtra = first.allocations.find((line) => line.amountCents === lempiras(8_400));

    assert.equal(firstExtra?.contractId, "a");

    // Second payment, with the balances the first one left behind. Lot "a" is
    // now L 100 further ahead, so it no longer holds the largest balance and
    // the extra moves on by itself.
    const afterFirst = first.allocations.map((line) => ({
      contractId: line.contractId,
      code: threeLots(0).find((lot) => lot.contractId === line.contractId)!.code,
      balanceCents: lempiras(100_000) - line.amountCents,
    }));

    const second = splitEvenly(lempiras(25_000), afterFirst);
    const secondExtra = second.allocations.find((line) => line.amountCents === lempiras(8_400));

    assert.notEqual(secondExtra?.contractId, "a");
  });

  it("leaves a paid-off lot out and spreads its share over the rest", () => {
    const result = splitEvenly(lempiras(25_000), [
      { contractId: "a", code: "CT-2026-001", balanceCents: lempiras(100_000) },
      { contractId: "b", code: "CT-2026-002", balanceCents: lempiras(100_000) },
      { contractId: "c", code: "CT-2026-003", balanceCents: 0 },
    ]);

    assert.equal(result.allocations.length, 2);
    assert.equal(result.unallocatedCents, 0);
    assert.deepEqual(
      result.allocations.map((line) => line.amountCents),
      [lempiras(12_500), lempiras(12_500)],
    );
  });

  it("never puts more on a lot than it still owes", () => {
    const result = splitEvenly(lempiras(25_000), [
      { contractId: "a", code: "CT-2026-001", balanceCents: lempiras(2_000) },
      { contractId: "b", code: "CT-2026-002", balanceCents: lempiras(100_000) },
    ]);

    const forA = result.allocations.find((line) => line.contractId === "a");
    const forB = result.allocations.find((line) => line.contractId === "b");

    assert.equal(forA?.amountCents, lempiras(2_000));
    assert.equal(forB?.amountCents, lempiras(23_000));
    assert.equal(result.unallocatedCents, 0);
  });

  it("hands back what the purchase does not owe instead of absorbing it", () => {
    const result = splitEvenly(lempiras(25_000), [
      { contractId: "a", code: "CT-2026-001", balanceCents: lempiras(4_000) },
      { contractId: "b", code: "CT-2026-002", balanceCents: lempiras(6_000) },
    ]);

    assert.equal(
      result.allocations.reduce((sum, line) => sum + line.amountCents, 0),
      lempiras(10_000),
    );
    assert.equal(result.unallocatedCents, lempiras(15_000));
  });

  it("always places the whole amount, to the centavo, when the purchase owes enough", () => {
    for (const amount of [lempiras(25_000), lempiras(10_000.37), lempiras(99.99), 1, lempiras(7)]) {
      const result = splitEvenly(amount, threeLots(100_000));
      const placed = result.allocations.reduce((sum, line) => sum + line.amountCents, 0);

      assert.equal(placed + result.unallocatedCents, amount, `lost centavos on ${amount}`);
      assert.equal(result.unallocatedCents, 0, `left ${result.unallocatedCents} unplaced`);
    }
  });

  it("splits a single-lot purchase without inventing a rounding problem", () => {
    const result = splitEvenly(lempiras(8_333.33), [
      { contractId: "a", code: "CT-2026-001", balanceCents: lempiras(100_000) },
    ]);

    assert.deepEqual(result.allocations, [{ contractId: "a", amountCents: lempiras(8_333.33) }]);
  });

  it("uses whole hundreds by default", () => {
    assert.equal(DEFAULT_ROUNDING_STEP_CENTS, lempiras(100));
  });
});
