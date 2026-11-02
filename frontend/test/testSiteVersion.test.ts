import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { versionPart } from "../src/lib/site";

/*
 * The branch and commit on the test site's strip, so a phone can tell whether
 * the change it is waiting for has arrived. Each comes from the build.
 */
describe("the test site's version", () => {
  it("shows the branch and the commit as the build was given them", () => {
    assert.equal(versionPart("ccr-9a01639b-hz7sp2"), "ccr-9a01639b-hz7sp2");
    assert.equal(versionPart(" 57ba544\n"), "57ba544");
  });

  it("is left off the strip when the build was not told, as on a dev server", () => {
    assert.equal(versionPart(undefined), "");
    assert.equal(versionPart(" "), "");
  });
});
