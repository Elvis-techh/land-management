import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { can, isRole } from "../src/lib/permissions.js";

describe("permissions", () => {
  it("lets an owner do everything staff can, and more", () => {
    assert.equal(can("owner", "payment:record"), true);
    assert.equal(can("owner", "lot:edit"), true);
    assert.equal(can("owner", "lot:archive"), true);
    assert.equal(can("owner", "payment:reverse"), true);
  });

  it("lets staff record day-to-day work", () => {
    assert.equal(can("staff", "payment:record"), true);
    assert.equal(can("staff", "customer:create"), true);
    assert.equal(can("staff", "contract:create"), true);
    assert.equal(can("staff", "lot:create"), true);
  });

  it("stops staff from changing history or destroying records", () => {
    assert.equal(can("staff", "lot:edit"), false);
    assert.equal(can("staff", "lot:archive"), false);
    assert.equal(can("staff", "payment:reverse"), false);
    assert.equal(can("staff", "contract:cancel"), false);
    assert.equal(can("staff", "price:change"), false);
    assert.equal(can("staff", "user:manage"), false);
  });

  it("only recognises known roles", () => {
    assert.equal(isRole("owner"), true);
    assert.equal(isRole("staff"), true);
    assert.equal(isRole("superadmin"), false);
    assert.equal(isRole(""), false);
  });
});
