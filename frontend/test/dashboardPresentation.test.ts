import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Cents } from "../src/lib/money";
import { groupPayers } from "../src/features/dashboard/dashboardPresentation";

/**
 * Grouping the month's payments into the people who made them.
 *
 * The figure this panel opens under counts CUSTOMERS, so the grouping is the
 * one place where a bug would put a different number on the panel than on the
 * tile above it — which is precisely the failure the whole drill-down design
 * exists to avoid.
 */

const cents = (amount: number) => Math.round(amount * 100) as Cents;

const payment = (customerId: string, customerName: string, amount: number, id = "") => ({
  id,
  customerId,
  customerName,
  amountCents: cents(amount),
});

describe("grouping the month's payers", () => {
  it("puts one row per customer, however many times they paid", () => {
    const payers = groupPayers([
      payment("a", "Ana", 1_000, "p1"),
      payment("a", "Ana", 2_000, "p2"),
      payment("b", "Beto", 500, "p3"),
      payment("a", "Ana", 300, "p4"),
    ]);

    assert.equal(payers.length, 2);
    assert.equal(payers[0]!.rows.length, 3);
    assert.equal(payers[1]!.rows.length, 1);
  });

  it("totals each person to exactly what they paid", () => {
    const payers = groupPayers([
      payment("a", "Ana", 1_000),
      payment("a", "Ana", 2_000),
      payment("b", "Beto", 500),
    ]);

    const ana = payers.find((row) => row.customerId === "a")!;

    assert.equal(ana.totalCents, cents(3_000));
    assert.equal(
      payers.reduce((total, row) => total + row.totalCents, 0),
      cents(3_500),
    );
  });

  it("ranks by money, like every other list on this screen", () => {
    const payers = groupPayers([
      payment("small", "Ana", 100),
      payment("big", "Beto", 9_000),
      payment("middle", "Carla", 4_000),
    ]);

    assert.deepEqual(
      payers.map((row) => row.customerId),
      ["big", "middle", "small"],
    );
  });

  it("breaks a tie by name, so the order does not shuffle between refreshes", () => {
    // Same amount, arriving in the wrong alphabetical order: without the
    // tie-break these two would sit in whatever order the server sent them,
    // which changes as payments are added.
    const payers = groupPayers([
      payment("z", "Zulema", 1_000),
      payment("a", "Ana", 1_000),
    ]);

    assert.deepEqual(
      payers.map((row) => row.customerName),
      ["Ana", "Zulema"],
    );
  });

  it("keeps every field of the payment it was handed", () => {
    // The panel renders the lot, the day and the method off these rows, so the
    // grouping must not narrow them to the three fields it sorts by.
    const payers = groupPayers([
      { ...payment("a", "Ana", 1_000, "p1"), lotCode: "A-07", method: "transfer" },
    ]);

    assert.equal(payers[0]!.rows[0]!.lotCode, "A-07");
    assert.equal(payers[0]!.rows[0]!.method, "transfer");
  });

  it("answers an empty month with an empty list rather than falling over", () => {
    assert.deepEqual(groupPayers([]), []);
  });
});
