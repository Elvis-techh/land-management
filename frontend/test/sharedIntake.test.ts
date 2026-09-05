import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readShareRequest } from "../src/lib/sharedIntake";

/*
 * Only `readShareRequest` is covered here, and deliberately so: it is the part
 * that decides whether a page load is an ordinary one or a share arriving, and
 * it runs on EVERY load. Getting it wrong in the "ordinary" direction would
 * pop the receipt form open on somebody who just opened the app.
 *
 * `takeSharedPayload` needs a real IndexedDB and is exercised on the device.
 */
describe("readShareRequest", () => {
  it("says nothing for an ordinary page load", () => {
    assert.equal(readShareRequest(""), null);
    assert.equal(readShareRequest("?"), null);
  });

  it("ignores unrelated query parameters", () => {
    assert.equal(readShareRequest("?tab=recibos&foo=bar"), null);
  });

  it("finds the id the service worker redirected with", () => {
    assert.deepEqual(readShareRequest("?compartido=abc-123"), { id: "abc-123" });
  });

  it("finds it alongside other parameters, in any position", () => {
    assert.deepEqual(readShareRequest("?a=1&compartido=xyz&b=2"), { id: "xyz" });
  });

  it("decodes a percent-encoded id", () => {
    // The worker encodes the id into the redirect; URLSearchParams decodes it.
    assert.deepEqual(readShareRequest("?compartido=a%2Fb"), { id: "a/b" });
  });

  it("recognises the worker's own failure signal", () => {
    assert.equal(readShareRequest("?compartido=error"), "failed");
  });

  /*
   * An empty value is the shape a half-built URL takes — "?compartido=" with
   * nothing after it. Treating it as an id would send the app looking up a
   * record keyed by the empty string, find nothing, and open the form with an
   * unexplained "no image" notice on a load nobody shared anything into.
   */
  it("treats an empty value as no share at all", () => {
    assert.equal(readShareRequest("?compartido="), null);
  });
});
