import type { TabId } from "../types";

/** Which form a file dropped on the window at large should open. */
export type WindowDropTarget =
  /** "Nueva transacción", with the comprobante attached. */
  | "receipt"
  /** "Nuevo contrato", with the signed paperwork attached. */
  | "contract";

/** Everything the answer below depends on, gathered in one place. */
export interface WindowDropContext {
  /** The screen the person is looking at. */
  tab: TabId;
  canRecordPayment: boolean;
  canFileContract: boolean;
  /** A FIRST load of the receipt form's lists that never landed. */
  isReceiptDataMissing: boolean;
  /** The same, for the lists the contract form needs. */
  isContractDataMissing: boolean;
  /** Something is already floating above the page. */
  isDialogOpen: boolean;
}

/**
 * Decide which form a window-wide drop opens, given where the person is.
 *
 * Pure and exported so the rule can be read and tested without a browser. It
 * exists because a dropped file is not self-describing: a JPG is a comprobante
 * on one screen and a scanned contract on another, and nothing about the file
 * says which. The screen already open is the only evidence there is, and it is
 * good evidence — somebody filing contracts is looking at Contratos.
 *
 * The default stays "receipt", from anywhere at all, because that is the
 * gesture the whole feature was built around: the slip arrives in a chat window
 * next to this one and goes straight onto Lindero, from whatever screen happens
 * to be up. Contratos is the one screen that overrides it.
 *
 * `null` means this app has nowhere to put the file. The caller still swallows
 * the drop — see `windowDropAction` — because a file dropped on a page the
 * browser does not handle makes it NAVIGATE to that file, replacing the app
 * with a JPEG and taking a half-typed form with it.
 */
export function windowDropTarget(context: WindowDropContext): WindowDropTarget | null {
  /*
   * Nothing behind a dialog answers a drop.
   *
   * The forms have dropzones of their own for a second file, and everything
   * else on top of the page is a form with typing in it or a document being
   * read — none of which should be swept away by a file landing on the window
   * behind them.
   */
  if (context.isDialogOpen) {
    return null;
  }

  /*
   * Contratos claims the drop only when it can act on it.
   *
   * A cashier who may record payments but not write contracts keeps the
   * app-wide behaviour on this tab rather than losing the gesture entirely:
   * the override is the tab having somewhere better to put the file, and a tab
   * that cannot take it has nowhere better.
   */
  if (context.tab === "contracts" && context.canFileContract && !context.isContractDataMissing) {
    return "contract";
  }

  if (context.canRecordPayment && !context.isReceiptDataMissing) {
    return "receipt";
  }

  return null;
}
