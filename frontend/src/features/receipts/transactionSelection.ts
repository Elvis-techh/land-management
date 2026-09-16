import type { Transaction } from "../../types";

/**
 * Every id from `fromId` to `toId`, inclusive — the shift-click range a
 * spreadsheet extends between the last box checked and the one just clicked.
 *
 * Works off `list`'s own order rather than an index passed in, so a shift-click
 * after the sort or the search box changes still spans exactly what is on
 * screen between the two rows, not whatever used to be between them.
 */
export function idsBetween(list: Transaction[], fromId: string, toId: string): string[] {
  const fromIndex = list.findIndex((transaction) => transaction.id === fromId);
  const toIndex = list.findIndex((transaction) => transaction.id === toId);

  if (fromIndex === -1 || toIndex === -1) {
    return [toId];
  }

  const [start, end] = fromIndex <= toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex];

  return list.slice(start, end + 1).map((transaction) => transaction.id);
}

/**
 * The rows printed on the same receipt as this one, itself included.
 *
 * A "transaction" on this screen is one row of `payments`, and a customer
 * holding three lots hands over ONE amount against ONE receipt that lands on
 * three contracts — so three rows. Asking what a payment was is therefore
 * almost never a question about one row: L 5,000 split A 2,000 / B 2,000 /
 * C 1,000 is one payment, and summing any single line of it answers nothing
 * anybody asked.
 *
 * A row with no receipt is its own group. This is the case that has to be
 * written down rather than left to fall out: `receiptId` is null for money
 * recorded before the app printed receipts, and grouping by null would make
 * every one of those rows a sibling of every other — checking one payment from
 * 2019 would check forty unrelated ones.
 */
export function receiptGroup(list: Transaction[], id: string): string[] {
  const row = list.find((transaction) => transaction.id === id);

  if (row === undefined || row.receiptId === null) {
    return [id];
  }

  return list
    .filter((transaction) => transaction.receiptId === row.receiptId)
    .map((transaction) => transaction.id);
}

/**
 * Whole receipts, never half of one.
 *
 * Applied as the LAST step of every gesture — click, shift-click and drag
 * alike — rather than woven into each of them. Three implementations of "and
 * also its siblings" is three chances for the click path and the drag path to
 * disagree about what is selected, and the disagreement would only show up on
 * the receipts that span several lots, which are exactly the ones this exists
 * for.
 */
export function expandToReceipts(
  list: Transaction[],
  ids: ReadonlySet<string>,
): ReadonlySet<string> {
  const byReceipt = new Set<string>();

  for (const transaction of list) {
    if (transaction.receiptId !== null && ids.has(transaction.id)) {
      byReceipt.add(transaction.receiptId);
    }
  }

  const expanded = new Set(ids);

  for (const transaction of list) {
    if (transaction.receiptId !== null && byReceipt.has(transaction.receiptId)) {
      expanded.add(transaction.id);
    }
  }

  return expanded;
}

/**
 * One row in or out, deciding which by what is on screen.
 *
 * The direction is read from the row's APPARENT state — a row checked only
 * because a sibling pulled it in still looks checked, and clicking something
 * that looks checked has to uncheck it. Turning it off therefore removes the
 * whole receipt: leaving the siblings behind would let `expandToReceipts` put
 * this row straight back, and the box would refuse to clear.
 */
export function toggleOne(
  list: Transaction[],
  checked: ReadonlySet<string>,
  id: string,
): ReadonlySet<string> {
  const next = new Set(checked);

  if (checked.has(id)) {
    for (const sibling of receiptGroup(list, id)) {
      next.delete(sibling);
    }
  } else {
    next.add(id);
  }

  return expandToReceipts(list, next);
}

/** Which way a press-and-drag is painting, decided on the row it started from. */
export type DragMode = "add" | "remove";

/**
 * What a drag has selected so far, recomputed from where it began.
 *
 * The rule is Airtable's and Excel's: the gesture owns a RANGE, not a trail.
 * Everything between the row the mouse went down on and the row it is over now
 * takes the drag's direction, and everything outside that range goes back to
 * exactly how it was before the drag started. Dragging down four rows and back
 * up two leaves two selected, because the two it passed over twice were never
 * "painted" — they were simply inside the range and then outside it again.
 *
 * That is why `before` is a parameter rather than something read from current
 * state: the answer has to be derived from the snapshot taken on mousedown
 * every single time the pointer moves. Building on the previous move's result
 * is what makes a drag one-way — it is how the old version behaved, and why
 * going back over a row you had just selected did nothing at all.
 *
 * The snapshot is the already-expanded set, which is the same thing as "how it
 * looked before this gesture". Shrinking the range therefore also releases the
 * siblings a wider range had pulled in, because they are not in `before` and
 * the expansion below is recomputed from scratch.
 */
export function paintedByDrag(
  list: Transaction[],
  before: ReadonlySet<string>,
  anchorId: string,
  toId: string,
  mode: DragMode,
): ReadonlySet<string> {
  const next = new Set(before);

  for (const id of idsBetween(list, anchorId, toId)) {
    if (mode === "add") {
      next.add(id);
    } else {
      // Same reasoning as `toggleOne`: a row is only truly out once its
      // receipt is, or the expansion at the end puts it back.
      for (const sibling of receiptGroup(list, id)) {
        next.delete(sibling);
      }
    }
  }

  return expandToReceipts(list, next);
}

/**
 * How many receipts the selection touches.
 *
 * The count the screen needs in two places: to say "4 seleccionadas · 1
 * recibo", and to decide whether the panel beside the list is still showing a
 * document that means anything. Rows with no receipt each count as their own,
 * because that is what they are — a payment that was never printed is not part
 * of some shared unprinted receipt.
 */
export function countReceipts(rows: Transaction[]): number {
  const receipts = new Set<string>();
  let unreceipted = 0;

  for (const row of rows) {
    if (row.receiptId === null) {
      unreceipted += 1;
    } else {
      receipts.add(row.receiptId);
    }
  }

  return receipts.size + unreceipted;
}
