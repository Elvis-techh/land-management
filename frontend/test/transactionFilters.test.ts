import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Transaction } from "../src/types";
import {
  NO_TRANSACTION_FILTERS,
  filterTransactions,
  searchTransactions,
  transactionsInScope,
} from "../src/features/receipts/transactionFilters";

/**
 * Five payments, two of them reversed.
 *
 * Only the fields the filters read are filled in — a whole `Transaction` is
 * more than any of these rules looks at, and writing one out five times would
 * bury the two columns that matter.
 */
const rows = [
  { id: "1", reversedAt: null, method: "cash", projectName: "Villas", paidOn: "2026-03-01" },
  { id: "2", reversedAt: null, method: "transfer", projectName: "Villas", paidOn: "2026-03-05" },
  { id: "3", reversedAt: "2026-03-09T12:00:00.000Z", method: "cash", projectName: "Villas", paidOn: "2026-03-07" },
  { id: "4", reversedAt: null, method: "cash", projectName: "Pinares", paidOn: "2026-03-08" },
  { id: "5", reversedAt: "2026-03-10T12:00:00.000Z", method: "card", projectName: "Pinares", paidOn: "2026-03-09" },
] as Transaction[];

describe("how many transactions are in scope", () => {
  it("counts down from the rows actually on the list, not from every row", () => {
    /*
     * The bug this replaced: the toolbar read "3 de 5" with nothing filtered,
     * because the list hides anuladas by default while the denominator counted
     * them. It looked exactly like a filter left switched on, and the filter
     * panel had nothing in it to clear.
     */
    assert.equal(filterTransactions(rows, NO_TRANSACTION_FILTERS).length, 3);
    assert.equal(transactionsInScope(rows, NO_TRANSACTION_FILTERS), 3);
  });

  it("still reads as narrowed when a filter really is on", () => {
    const filters = { ...NO_TRANSACTION_FILTERS, projects: ["Pinares"] };

    assert.equal(filterTransactions(rows, filters).length, 1);
    assert.equal(transactionsInScope(rows, filters), 3);
  });

  it("widens to the whole history once anuladas are asked for", () => {
    // Choosing a status is opting into seeing reversed rows, so "1 de 5" is
    // the honest reading: one slice of everything there is.
    const filters = { ...NO_TRANSACTION_FILTERS, statuses: ["reversed" as const] };

    assert.equal(transactionsInScope(rows, filters), rows.length);
  });
});

describe("searching the transactions", () => {
  /*
   * The row no longer prints the receipt code, so this is how anybody finds a
   * payment by it — including a barcode scanner, which types the printed code
   * as if from a keyboard. If this stops matching, that way of finding a
   * receipt is gone.
   */
  const printed = [
    { id: "1", customerName: "Ana Valle", receiptCode: "IM-482739156034" },
    { id: "2", customerName: "Luis Mejía", receiptCode: "IM-905112837461" },
    { id: "3", customerName: "Rosa Paz", receiptCode: null },
  ] as Transaction[];

  it("finds a payment by the code printed under the receipt's barcode", () => {
    assert.deepEqual(
      searchTransactions(printed, "IM-482739156034").map((row) => row.id),
      ["1"],
    );
  });

  it("finds it from the digits alone, and whatever the case", () => {
    assert.deepEqual(searchTransactions(printed, "905112837461").map((row) => row.id), ["2"]);
    assert.deepEqual(searchTransactions(printed, "im-9051").map((row) => row.id), ["2"]);
  });

  it("finds it when a scanner ends the code with a space", () => {
    assert.deepEqual(searchTransactions(printed, "IM-482739156034 ").map((row) => row.id), ["1"]);
  });
});
