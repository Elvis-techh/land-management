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
 * One row in or out — exactly the row clicked, nothing else.
 *
 * A receipt covering three lots used to check or uncheck all three together,
 * on the reasoning that they are one payment. That made it impossible to
 * isolate a single lot's line out of the group: unchecking one always
 * released the whole receipt, because the row was only "in" as a sibling and
 * the group would put it straight back. A plain click now only ever touches
 * the row it landed on — checking every line of a receipt on purpose is a
 * drag across them, or a click on each box in turn.
 */
export function toggleOne(checked: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(checked);

  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }

  return next;
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
 * Paints exactly the rows the pointer has actually crossed — a receipt with
 * several lots is only fully selected once the drag has passed over all of
 * them, not because one of them pulled the rest in. See `toggleOne` for why.
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
      next.delete(id);
    }
  }

  return next;
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
