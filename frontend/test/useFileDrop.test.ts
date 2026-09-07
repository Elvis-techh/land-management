import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { windowDropAction } from "../src/lib/useFileDrop";

/*
 * Only the decision is covered here, and that is the whole of the interesting
 * part: the hook around it is four listeners and a counter, but this function
 * runs on EVERY drag that crosses the app, and two of its three answers exist
 * to protect work already on screen rather than to do anything.
 *
 * The listeners themselves need a browser and are exercised by dragging a file
 * onto the running app.
 */

/** A drag the app can take: files, nobody nearer claimed it, form available. */
const takeable = { types: ["Files"], handledNearer: false, accepting: true };

describe("windowDropAction", () => {
  it("takes a file dragged onto the window", () => {
    assert.equal(windowDropAction(takeable), "accept");
  });

  /*
   * Dragging is not only for files. The dashboard's section bars are
   * `draggable`, and any page of text can be selected and dragged. Answering
   * anything but "ignore" here would preventDefault on those and break
   * reordering the dashboard.
   */
  it("leaves a drag that carries no files entirely alone", () => {
    assert.equal(
      windowDropAction({ ...takeable, types: ["text/plain", "text/html"] }),
      "ignore",
    );
    assert.equal(windowDropAction({ ...takeable, types: [] }), "ignore");
  });

  /*
   * "Files" is a bare word among MIME types, and it is matched exactly. A drag
   * carrying a text file's CONTENT advertises a MIME type; only a drag of the
   * file itself is labelled this way.
   */
  it("matches the files marker exactly", () => {
    assert.equal(windowDropAction({ ...takeable, types: ["files"] }), "ignore");
    assert.equal(windowDropAction({ ...takeable, types: ["application/Files"] }), "ignore");
  });

  /*
   * The receipt panel's own dropzone attaches a slip to the receipt already on
   * screen. It calls preventDefault on the way past, and it has to keep
   * winning: one drop cannot both file the comprobante and open a form to
   * record the payment a second time.
   */
  it("stands down when a dropzone nearer the pointer took the drag", () => {
    assert.equal(windowDropAction({ ...takeable, handledNearer: true }), "ignore");
  });

  /*
   * The expensive case. Dropping a file on a page that does not handle it
   * makes the browser NAVIGATE to that file — the app is replaced by a JPEG,
   * and a receipt form with an amount typed into it goes with it. So a drop
   * that cannot be used is still swallowed.
   */
  it("swallows a file it cannot use rather than letting the browser navigate", () => {
    assert.equal(windowDropAction({ ...takeable, accepting: false }), "block");
  });

  /*
   * Only when nobody else is dealing with it, though: a zone that claimed the
   * drag has already called preventDefault, and blocking on top of that would
   * mean answering for a drop that was handled perfectly well.
   */
  it("still defers to a nearer dropzone while it cannot accept", () => {
    assert.equal(
      windowDropAction({ types: ["Files"], handledNearer: true, accepting: false }),
      "ignore",
    );
  });
});
