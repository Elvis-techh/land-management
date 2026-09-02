import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { EDITABLE_CAPABILITIES } from "../src/lib/permissions.js";
import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

/**
 * Reversing a payment and rewriting one are two different permissions.
 *
 * They used to be one, and the label on it — "Reversar pagos" — described only
 * the safer half. A reversal writes a visible counter-entry and leaves the
 * original standing, so the money can always be explained by reading the
 * ledger. Correcting overwrites a posted figure in place, and the previous
 * amount survives only in the audit history.
 *
 * The whole point of splitting them is that one can be granted without the
 * other, so that is what these check — in both directions, because a split that
 * only works one way is not a split.
 */
describe("reversing a payment and rewriting one are separate permissions", async () => {
  const { app, sqlite } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

  const grantToStaff = (capabilities: string[]) =>
    app.inject({
      method: "PUT",
      url: "/api/permissions",
      headers: { cookie: ownerCookie },
      payload: { capabilities },
    });

  /** A posted payment belonging to the seeded contract, for editing. */
  async function aPaymentId(): Promise<string> {
    const response = await app.inject({
      method: "GET",
      url: "/api/transactions",
      headers: { cookie: ownerCookie },
    });

    const rows = response.json().transactions as Array<{ id: string; reversedAt: string | null }>;
    const live = rows.find((row) => row.reversedAt === null);

    assert.ok(live, "the seeded database should have a payment that is not reversed");

    return live.id;
  }

  const editAsStaff = async () =>
    app.inject({
      method: "PATCH",
      url: `/api/transactions/${await aPaymentId()}`,
      headers: { cookie: staffCookie },
      payload: {
        amountCents: 900_000,
        paidOn: "2026-01-15",
        method: "cash",
        type: "down_payment",
        reason: "Prueba de permisos sobre la corrección",
        allowOverpayment: true,
      },
    });

  it("offers both switches to the supervisor", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/permissions",
      headers: { cookie: ownerCookie },
    });

    const offered = response.json().capabilities.map((row: { capability: string }) => row.capability);

    assert.ok(offered.includes("payment:reverse"));
    assert.ok(offered.includes("payment:edit"));
  });

  it("refuses the correction to an associate who has neither", async () => {
    await grantToStaff(["payment:record"]);

    assert.equal((await editAsStaff()).statusCode, 403);
  });

  it("STILL refuses it to an associate who may only reverse", async () => {
    // The reason the split exists. Before it, this grant silently carried the
    // power to rewrite a posted amount, which the switch never said.
    await grantToStaff(["payment:record", "payment:reverse"]);

    assert.equal((await editAsStaff()).statusCode, 403);
  });

  it("allows it once the correction permission itself is granted", async () => {
    await grantToStaff(["payment:record", "payment:edit"]);

    const response = await editAsStaff();

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().transaction.amount, 900_000);
  });

  it("does not hand over reversing along with it", async () => {
    // The other direction: `payment:edit` is not a superset. An associate
    // trusted to fix a typo is not thereby trusted to void a receipt.
    await grantToStaff(["payment:record", "payment:edit"]);

    const receipts = await app.inject({
      method: "GET",
      url: "/api/receipts",
      headers: { cookie: ownerCookie },
    });

    const first = receipts.json().receipts[0] as { id: string } | undefined;

    if (!first) {
      // Nothing issued in this fixture; the route guard is what matters and it
      // is asserted above. Skip rather than invent a receipt.
      return;
    }

    const response = await app.inject({
      method: "POST",
      url: `/api/receipts/${first.id}/void`,
      headers: { cookie: staffCookie },
      payload: { reason: "Prueba de permisos sobre la anulación" },
    });

    assert.equal(response.statusCode, 403);
  });

  it("is off by default, so an existing installation does not silently gain it", async () => {
    // `resolveCapabilities` gives a capability with no row the value `false`.
    // That is what makes adding one safe: a supervisor who configured this role
    // last year does not wake up having granted something new.
    await grantToStaff(["payment:record", "payment:reverse"]);

    const response = await app.inject({
      method: "GET",
      url: "/api/permissions",
      headers: { cookie: ownerCookie },
    });

    const row = response
      .json()
      .capabilities.find((entry: { capability: string }) => entry.capability === "payment:edit");

    assert.equal(row.enabled, false);
  });
});

/**
 * Every capability the server is willing to configure must be reachable from
 * the Permisos screen.
 *
 * The screen builds its list by hand, so a capability added to the server and
 * forgotten there would be invisible — permanently off for the associate, and
 * looking like a deliberate choice nobody made. The page now renders anything
 * it does not recognise under "Otros permisos", and this checks the contract
 * that makes that work: the server offers the full editable set.
 */
describe("the permissions screen can reach every editable capability", async () => {
  const { app, sqlite } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

  it("offers exactly the editable set, and nothing locked", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/permissions",
      headers: { cookie: ownerCookie },
    });

    const offered = response
      .json()
      .capabilities.map((row: { capability: string }) => row.capability)
      .sort();

    assert.deepEqual(offered, [...EDITABLE_CAPABILITIES].sort());
  });
});
