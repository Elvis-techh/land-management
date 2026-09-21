import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Transaction } from "../src/types";
import { countReceipts, idsBetween, paintedByDrag, toggleOne } from "../src/features/receipts/transactionSelection";

/*
 * The arithmetic behind dragging across a ledger.
 *
 * Worth pinning down because every one of these rules is invisible until it is
 * wrong: a range that paints one row too many, a box that will not let go, a
 * total that is not the total of what somebody actually picked.
 */

/**
 * Six rows, in the order they appear on screen.
 *
 * Rows 3 and 4 are one receipt covering two lots — the case that used to force
 * a whole-receipt selection and now must NOT. Rows 5 and 6 have no receipt at
 * all, which is how money recorded before the app printed receipts looks.
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

describe("toggleOne", () => {
  it("checks exactly the row clicked", () => {
    assert.deepEqual(ids(toggleOne(new Set(), "3")), ["3"]);
  });

  it("unchecks exactly the row clicked, leaving a sibling from the same receipt alone", () => {
    const checked = toggleOne(toggleOne(new Set(), "3"), "4");
    assert.deepEqual(ids(checked), ["3", "4"]);
    assert.deepEqual(ids(toggleOne(checked, "4")), ["3"]);
  });

  /*
   * The exact case this rule exists for: two lots of the same receipt are both
   * checked, and clicking one of them has to isolate the OTHER — not release
   * the pair back to nothing, which is what the old whole-receipt expansion did.
   */
  it("lets a single row be isolated out of a receipt that covers several", () => {
    const both = toggleOne(toggleOne(new Set(), "3"), "4");
    assert.deepEqual(ids(toggleOne(both, "3")), ["4"]);
  });

  it("leaves everything else where it was", () => {
    const checked = toggleOne(new Set(["1"]), "3");
    assert.deepEqual(ids(checked), ["1", "3"]);
    assert.deepEqual(ids(toggleOne(checked, "3")), ["1"]);
  });
});

describe("paintedByDrag", () => {
  it("selects exactly the range it is dragged across", () => {
    assert.deepEqual(ids(paintedByDrag(rows, new Set(), "1", "3", "add")), ["1", "2", "3"]);
  });

  /* A receipt covering several lots is only fully selected once the drag has
     actually passed over all of them — row 4 is not pulled in just because
     row 3, its sibling, was crossed. */
  it("does not pull in a sibling row the drag never reached", () => {
    assert.deepEqual(ids(paintedByDrag(rows, new Set(), "1", "3", "add")), ["1", "2", "3"]);
    assert.deepEqual(ids(paintedByDrag(rows, new Set(), "3", "4", "add")), ["3", "4"]);
  });

  it("releases what the range no longer covers when the drag comes back", () => {
    const wide = paintedByDrag(rows, new Set(), "1", "3", "add");
    assert.deepEqual(ids(wide), ["1", "2", "3"]);

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

  it("unpaints only the row it crosses, leaving its receipt sibling checked", () => {
    const before = new Set(["1", "2", "3", "4"]);
    assert.deepEqual(ids(paintedByDrag(rows, before, "3", "3", "remove")), ["1", "2", "4"]);
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
