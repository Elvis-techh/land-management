import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WindowDropContext } from "../src/lib/windowDropTarget";
import { windowDropTarget } from "../src/lib/windowDropTarget";

/*
 * A dropped file is not self-describing: the same JPG is a comprobante on one
 * screen and a scanned contract on another. This function is the whole of how
 * the app tells them apart, and it runs on every file dropped anywhere, so the
 * cases where it must NOT change its mind are as interesting as the one where
 * it must.
 */

/** Somebody who can do everything, on the screen most drops arrive from. */
const owner: WindowDropContext = {
  tab: "receipts",
  canRecordPayment: true,
  canFileContract: true,
  isReceiptDataMissing: false,
  isContractDataMissing: false,
  isDialogOpen: false,
};

describe("windowDropTarget", () => {
  it("opens a new transaction from anywhere but Contratos", () => {
    for (const tab of ["dashboard", "lots", "projects", "customers", "receipts", "audit"] as const) {
      assert.equal(windowDropTarget({ ...owner, tab }), "receipt", `on ${tab}`);
    }
  });

  it("opens a new contract on the Contratos tab instead", () => {
    assert.equal(windowDropTarget({ ...owner, tab: "contracts" }), "contract");
  });

  /*
   * Everything on top of the page is either a form with typing in it, a
   * document being read, or a form with a dropzone of its own. None of them
   * should be swept away by a file landing on the window behind.
   */
  it("stands down while a dialog is open, on either tab", () => {
    assert.equal(windowDropTarget({ ...owner, isDialogOpen: true }), null);
    assert.equal(
      windowDropTarget({ ...owner, tab: "contracts", isDialogOpen: true }),
      null,
    );
  });

  /*
   * The override is the tab having somewhere BETTER to put the file. A cashier
   * who cannot write contracts has nowhere better, so the app-wide behaviour
   * stands rather than the gesture going dead on one screen.
   */
  it("falls back to a transaction on Contratos when contracts cannot be written", () => {
    assert.equal(
      windowDropTarget({ ...owner, tab: "contracts", canFileContract: false }),
      "receipt",
    );
  });

  it("falls back the same way when the contract lists failed to load", () => {
    assert.equal(
      windowDropTarget({ ...owner, tab: "contracts", isContractDataMissing: true }),
      "receipt",
    );
  });

  /* Neither form available is the one case with no answer at all. The caller
     still swallows the drop, or the browser navigates away to the file. */
  it("has no answer for somebody who can do neither", () => {
    assert.equal(
      windowDropTarget({ ...owner, canRecordPayment: false, canFileContract: false }),
      null,
    );
    assert.equal(
      windowDropTarget({
        ...owner,
        tab: "contracts",
        canRecordPayment: false,
        canFileContract: false,
      }),
      null,
    );
  });

  it("does not offer a transaction whose lists never arrived", () => {
    assert.equal(
      windowDropTarget({ ...owner, canFileContract: false, isReceiptDataMissing: true }),
      null,
    );
  });

  /*
   * Permission is per form, not pooled. Somebody who may write contracts but
   * not record payments gets the contract form on Contratos and nothing
   * anywhere else — dropping a comprobante would open a form the server would
   * refuse to submit.
   */
  it("keeps the two permissions apart", () => {
    const filesContractsOnly = { ...owner, canRecordPayment: false };

    assert.equal(windowDropTarget({ ...filesContractsOnly, tab: "contracts" }), "contract");
    assert.equal(windowDropTarget({ ...filesContractsOnly, tab: "receipts" }), null);
  });
});
