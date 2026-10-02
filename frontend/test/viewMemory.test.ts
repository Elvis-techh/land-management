import assert from "node:assert/strict";
import { test } from "node:test";

import { forgetViewMemory, recallView, rememberView } from "../src/lib/viewMemory";

test("a screen with nothing remembered starts at its default", () => {
  forgetViewMemory();
  assert.equal(recallView("contracts.sort", "default"), "default");
});

test("coming back to a screen finds it the way it was left", () => {
  forgetViewMemory();
  const filters = { status: "overdue", projectId: "p1" };
  rememberView("contracts.filters", filters);
  assert.deepEqual(recallView("contracts.filters", {}), filters);
});

test("a remembered false or empty string is not mistaken for nothing", () => {
  forgetViewMemory();
  rememberView("lots.showArchived", false);
  rememberView("receipts.search", "");
  assert.equal(recallView("lots.showArchived", true), false);
  assert.equal(recallView("receipts.search", "fallback"), "");
});

test("signing out puts every screen back to its default", () => {
  rememberView("contracts.sort", "balance");
  rememberView("receipts.view", "customer");
  forgetViewMemory();
  assert.equal(recallView("contracts.sort", "default"), "default");
  assert.equal(recallView("receipts.view", "date"), "date");
});
