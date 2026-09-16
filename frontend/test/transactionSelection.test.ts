import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Transaction } from "../src/types";
import {
  countReceipts,
  expandToReceipts,
  idsBetween,
  paintedByDrag,
  receiptGroup,
  toggleOne,
} from "../src/features/receipts/transactionSelection";

/*
 * The arithmetic behind dragging across a ledger.
 *
 * Worth pinning down because every one of these rules is invisible until it is
 * wrong: a range that paints one row too many, a sibling that will not let go,
 * a receipt half-selected. None of them throws, none of them shows up in a
 * type, and all of them end with somebody reading a total that is not the total
 * of what they picked.
 */

/**
 * Six rows, in the order they appear on screen.
 *
 * Rows 3 and 4 are one receipt covering two lots — the case the whole
 * expansion rule exists for. Rows 5 and 6 have no receipt at all, which is how
 * money recorded before the app printed receipts looks, and they must never be
 * treated as siblings of each other.
 */
const rows = [
  { id: "1", receiptId: "r1" },
  { id: "2", receiptId: "r2" },
  { id: "3", receiptId: "r3" },
  { id: "4", receiptId: "r3" },
  { id: "5", receiptId: null },
  { id: "6", receiptId: null },
] as Transaction[];

const ids = (set: ReadonlySet<string>) => [...set].sort();

describe("idsBetween", () => {
  it("spans downwards, inclusive of both ends", () => {
    assert.deepEqual(idsBetween(rows, "2", "4"), ["2", "3", "4"]);
  });

  it("spans upwards to the same range, because a range has no direction", () => {
    assert.deepEqual(idsBetween(rows, "4", "2"), ["2", "3", "4"]);
  });

  it("is just the one row when both ends are the same", () => {
    assert.deepEqual(idsBetween(rows, "3", "3"), ["3"]);
  });

  /*
   * The anchor survives a search that removes it: somebody shift-clicks, then
   * types in the search box, then shift-clicks again. Extending from a row that
   * is no longer on screen would span whatever happened to be where it used to
   * be, so the range collapses to the row actually clicked instead.
   */
  it("falls back to the clicked row when the anchor has been filtered away", () => {
    assert.deepEqual(idsBetween(rows, "gone", "3"), ["3"]);
  });
});

describe("receiptGroup", () => {
  it("returns the lots of a receipt that covers several", () => {
    assert.deepEqual(receiptGroup(rows, "3").sort(), ["3", "4"]);
  });

  it("returns just the row for a receipt covering one lot", () => {
    assert.deepEqual(receiptGroup(rows, "1"), ["1"]);
  });

  /* The case that would otherwise join every un-receipted payment ever made. */
  it("never makes siblings of two payments that simply have no receipt", () => {
    assert.deepEqual(receiptGroup(rows, "5"), ["5"]);
    assert.deepEqual(receiptGroup(rows, "6"), ["6"]);
  });

  it("returns the row itself when it is not in the list at all", () => {
    assert.deepEqual(receiptGroup(rows, "gone"), ["gone"]);
  });
});

describe("expandToReceipts", () => {
  it("pulls in the other lots of a receipt", () => {
    assert.deepEqual(ids(expandToReceipts(rows, new Set(["3"]))), ["3", "4"]);
  });

  it("leaves a one-lot receipt alone", () => {
    assert.deepEqual(ids(expandToReceipts(rows, new Set(["1"]))), ["1"]);
  });

  it("leaves an un-receipted payment alone", () => {
    assert.deepEqual(ids(expandToReceipts(rows, new Set(["5"]))), ["5"]);
  });

  it("is idempotent, so it can run at the end of every gesture", () => {
    const once = expandToReceipts(rows, new Set(["3"]));
    assert.deepEqual(ids(expandToReceipts(rows, once)), ids(once));
  });
});

describe("toggleOne", () => {
  it("checks a row and its receipt in one press", () => {
    assert.deepEqual(ids(toggleOne(rows, new Set(), "3")), ["3", "4"]);
  });

  /*
   * The bug this rule exists to prevent: row 4 is only checked because row 3
   * pulled it in, so clicking row 4 has to release BOTH. Removing row 4 alone
   * would leave row 3 checked, the expansion would immediately restore row 4,
   * and the box would look broken.
   */
  it("releases the whole receipt when a row that was pulled in is clicked", () => {
    const checked = toggleOne(rows, new Set(), "3");
    assert.deepEqual(ids(toggleOne(rows, checked, "4")), []);
  });

  it("leaves everything else where it was", () => {
    const checked = toggleOne(rows, new Set(["1"]), "3");
    assert.deepEqual(ids(checked), ["1", "3", "4"]);
    assert.deepEqual(ids(toggleOne(rows, checked, "3")), ["1"]);
  });
});

describe("paintedByDrag", () => {
  it("selects the range it is dragged across", () => {
    assert.deepEqual(ids(paintedByDrag(rows, new Set(), "1", "3", "add")), ["1", "2", "3", "4"]);
  });

  /*
   * The behaviour that was asked for by name. Dragging down to row 3 and back
   * up to row 2 must leave rows 1 and 2 — and must also let go of row 4, which
   * only came along because row 3 was briefly inside the range.
   */
  it("releases what the range no longer covers when the drag comes back", () => {
    const wide = paintedByDrag(rows, new Set(), "1", "3", "add");
    assert.deepEqual(ids(wide), ["1", "2", "3", "4"]);

    const narrowed = paintedByDrag(rows, new Set(), "1", "2", "add");
    assert.deepEqual(ids(narrowed), ["1", "2"]);
  });

  it("keeps what was already selected outside the range", () => {
    assert.deepEqual(ids(paintedByDrag(rows, new Set(["6"]), "1", "2", "add")), ["1", "2", "6"]);
  });

  /* A drag that starts on a checked row unchecks instead, the whole way. */
  it("unpaints when it starts on something already selected", () => {
    const before = new Set(["1", "2", "3", "4"]);
    assert.deepEqual(ids(paintedByDrag(rows, before, "1", "2", "remove")), ["3", "4"]);
  });

  it("takes whole receipts out when unpainting across one", () => {
    const before = new Set(["1", "2", "3", "4"]);
    assert.deepEqual(ids(paintedByDrag(rows, before, "3", "3", "remove")), ["1", "2"]);
  });
});

describe("countReceipts", () => {
  it("counts one receipt however many lots it covers", () => {
    assert.equal(countReceipts([rows[2]!, rows[3]!]), 1);
  });

  it("counts separate receipts separately", () => {
    assert.equal(countReceipts([rows[0]!, rows[1]!]), 2);
  });

  /* Two payments that were never printed are two things, not one. */
  it("counts each un-receipted payment on its own", () => {
    assert.equal(countReceipts([rows[4]!, rows[5]!]), 2);
  });

  it("is zero for nothing", () => {
    assert.equal(countReceipts([]), 0);
  });
});
