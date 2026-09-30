import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_SORT, groupByCustomer, sortTransactions } from "../src/features/receipts/transactionSort";
import type { Transaction } from "../src/types";

/**
 * Three payments from one receipt covering three lots, all posted inside the
 * same database transaction and so stamped from the same `new Date()`. This
 * exact shape is what the ledger-order regression in transactionSort.ts's own
 * comment describes: tied on `paidOn` AND `createdAt`, settled only by `id`.
 */
const tiedTrio = [
  { id: "b", paidOn: "2026-08-30", createdAt: "2026-08-30T10:00:00.000Z" },
  { id: "a", paidOn: "2026-08-30", createdAt: "2026-08-30T10:00:00.000Z" },
  { id: "c", paidOn: "2026-08-30", createdAt: "2026-08-30T10:00:00.000Z" },
] as Transaction[];

describe("sortTransactions — ledger order", () => {
  it("is the exact reverse ordering, oldest-first vs newest-first, id included", () => {
    // The bug this guards: `paidOn` and `createdAt` used to flip with the
    // direction while the final `id` comparison stayed ascending, so three
    // payments tied this tightly came out in the SAME relative order whether
    // the direction was "más antiguos" or "más recientes primero".
    const oldestFirst = sortTransactions(tiedTrio, [{ field: "date", direction: "asc" }]);
    const newestFirst = sortTransactions(tiedTrio, [{ field: "date", direction: "desc" }]);

    assert.deepEqual(
      newestFirst.map((row) => row.id),
      [...oldestFirst.map((row) => row.id)].reverse(),
    );
  });

  it("defaults to newest first", () => {
    const ordered = sortTransactions(tiedTrio, DEFAULT_SORT);
    const oldestFirst = sortTransactions(tiedTrio, [{ field: "date", direction: "asc" }]);

    assert.deepEqual(
      ordered.map((row) => row.id),
      [...oldestFirst.map((row) => row.id)].reverse(),
    );
  });
});

describe("sortTransactions — multiple levels", () => {
  const rows = [
    { id: "1", customerName: "Beatriz", amount: 500, paidOn: "2026-01-01", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "2", customerName: "Ana", amount: 900, paidOn: "2026-01-02", createdAt: "2026-01-02T00:00:00.000Z" },
    { id: "3", customerName: "Ana", amount: 100, paidOn: "2026-01-03", createdAt: "2026-01-03T00:00:00.000Z" },
  ] as Transaction[];

  it("breaks ties on the primary field using the secondary one", () => {
    const ordered = sortTransactions(rows, [
      { field: "customer", direction: "asc" },
      { field: "amount", direction: "desc" },
    ]);

    // Both Ana rows sort before Beatriz; between the two Anas, the bigger
    // amount comes first because that is the SECOND level, not the first.
    assert.deepEqual(
      ordered.map((row) => row.id),
      ["2", "3", "1"],
    );
  });

  it("never lets the secondary level override the primary one", () => {
    const ordered = sortTransactions(rows, [
      { field: "customer", direction: "asc" },
      { field: "amount", direction: "asc" },
    ]);

    // Ana (600 → 100, but still "Ana" first) always precedes Beatriz, whatever
    // the amount level says — it only breaks ties WITHIN a name.
    const names = ordered.map((row) => row.customerName);
    assert.deepEqual(names, ["Ana", "Ana", "Beatriz"]);
  });
});

describe("sortTransactions — project", () => {
  const rows = [
    { id: "1", projectName: "Monte Real", paidOn: "2026-01-01", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "2", projectName: "Valle Verde", paidOn: "2026-01-02", createdAt: "2026-01-02T00:00:00.000Z" },
    { id: "3", projectName: "Alameda", paidOn: "2026-01-03", createdAt: "2026-01-03T00:00:00.000Z" },
  ] as Transaction[];

  it("orders by the lot's project name", () => {
    const ordered = sortTransactions(rows, [{ field: "project", direction: "asc" }]);

    assert.deepEqual(
      ordered.map((row) => row.projectName),
      ["Alameda", "Monte Real", "Valle Verde"],
    );
  });
});

describe("groupByCustomer — per-contract breakdown", () => {
  /**
   * Josue's Pineda-shaped case: money paid on CT-2026-011 before it was
   * replaced, plus money paid on its -A1 successor after. `contractStatus`
   * is what the join returns TODAY — "replaced" on the old contract's rows
   * even though it was "active" when that money actually moved.
   */
  const amendedCustomer = [
    {
      id: "1",
      customerId: "cust-1",
      customerName: "Josue Pineda",
      customerIdentification: "0801",
      paidOn: "2026-01-01",
      createdAt: "2026-01-01T00:00:00.000Z",
      amount: 174000_00,
      reversedAt: null,
      contractId: "contract-old",
      contractCode: "CT-2026-011",
      contractStatus: "replaced",
    },
    {
      id: "2",
      customerId: "cust-1",
      customerName: "Josue Pineda",
      customerIdentification: "0801",
      paidOn: "2026-09-15",
      createdAt: "2026-09-15T00:00:00.000Z",
      amount: 150000_00,
      reversedAt: null,
      contractId: "contract-new",
      contractCode: "CT-2026-011-A1",
      contractStatus: "active",
    },
    // Reversed: must count toward neither the total nor either subtotal.
    {
      id: "3",
      customerId: "cust-1",
      customerName: "Josue Pineda",
      customerIdentification: "0801",
      paidOn: "2026-09-16",
      createdAt: "2026-09-16T00:00:00.000Z",
      amount: 5000_00,
      reversedAt: "2026-09-17T00:00:00.000Z",
      contractId: "contract-new",
      contractCode: "CT-2026-011-A1",
      contractStatus: "active",
    },
  ] as unknown as Transaction[];

  it("splits the total by contract, predecessor before successor, reversed rows excluded", () => {
    const [group] = groupByCustomer(amendedCustomer, DEFAULT_SORT);

    assert.equal(group!.totalCents, 174000_00 + 150000_00);
    assert.deepEqual(
      group!.byContract.map((entry) => [entry.contractCode, entry.contractStatus, entry.totalCents]),
      [
        ["CT-2026-011", "replaced", 174000_00],
        ["CT-2026-011-A1", "active", 150000_00],
      ],
    );
    assert.equal(group!.hasAmendment, true);
  });

  it("leaves an unamended customer with one subtotal and no badge", () => {
    const rows = [
      {
        id: "1",
        customerId: "cust-2",
        customerName: "Ana Lucía Paz",
        customerIdentification: "0802",
        paidOn: "2026-01-01",
        createdAt: "2026-01-01T00:00:00.000Z",
        amount: 7000_00,
        reversedAt: null,
        contractId: "contract-a",
        contractCode: "CT-2026-005",
        contractStatus: "active",
      },
    ] as unknown as Transaction[];

    const [group] = groupByCustomer(rows, DEFAULT_SORT);

    assert.equal(group!.byContract.length, 1);
    assert.equal(group!.hasAmendment, false);
  });
});
