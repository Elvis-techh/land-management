import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

describe("repricing a lot that is under contract", async () => {
  const { app, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

  const reprice = (cookie: string, basePriceCents: number, reason?: string) =>
    app.inject({
      method: "PATCH",
      url: `/api/lots/${ids.heldLotId}`,
      headers: { cookie },
      payload: {
        code: "A-01",
        projectName: "Proyecto Prueba",
        areaM2: 300,
        basePriceCents,
        ...(reason ? { reason } : {}),
      },
    });

  it("refuses without a written reason", async () => {
    const response = await reprice(ownerCookie, 20_000_000);

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "reason_required");
    // The message names the contract that makes this consequential.
    assert.match(response.json().message, /CT-TEST-001/);
  });

  it("still refuses staff outright", async () => {
    const response = await reprice(staffCookie, 20_000_000, "Renegociado con el cliente.");
    assert.equal(response.statusCode, 403);
  });

  it("allows the change when a reason is given", async () => {
    const response = await reprice(ownerCookie, 20_000_000, "Renegociado con el cliente en agosto.");
    assert.equal(response.statusCode, 200);

    const lots = (
      await app.inject({ method: "GET", url: "/api/lots", headers: { cookie: ownerCookie } })
    ).json().lots;

    const held = lots.find((lot: { code: string }) => lot.code === "A-01");
    assert.equal(held.basePrice, 20_000_000);
  });

  it("does not touch what the customer already owes", async () => {
    const lots = (
      await app.inject({ method: "GET", url: "/api/lots", headers: { cookie: ownerCookie } })
    ).json().lots;

    const held = lots.find((lot: { code: string }) => lot.code === "A-01");

    // The contract keeps its own agreed salePrice. Repricing the lot changes
    // the asking price for the future, never an existing agreement.
    assert.equal(held.holding.salePrice, 18_500_000);
    assert.equal(held.holding.paidToDate, 1_500_000);
  });

  it("needs no reason for a lot with no contract", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/lots/${ids.freeLotId}`,
      headers: { cookie: ownerCookie },
      payload: {
        code: "A-02",
        projectName: "Proyecto Prueba",
        areaM2: 280,
        basePriceCents: 17_000_000,
      },
    });

    assert.equal(response.statusCode, 200);
  });
});

describe("audit history endpoint", async () => {
  const { app, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

  it("is hidden from staff", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/audit",
      headers: { cookie: staffCookie },
    });

    assert.equal(response.statusCode, 403);
  });

  it("requires a session at all", async () => {
    const response = await app.inject({ method: "GET", url: "/api/audit" });
    assert.equal(response.statusCode, 401);
  });

  it("records a reprice under its own action, with the reason", async () => {
    await app.inject({
      method: "PATCH",
      url: `/api/lots/${ids.heldLotId}`,
      headers: { cookie: ownerCookie },
      payload: {
        code: "A-01",
        projectName: "Proyecto Prueba",
        areaM2: 300,
        basePriceCents: 19_000_000,
        reason: "Ajuste acordado con el cliente.",
      },
    });

    const body = (
      await app.inject({ method: "GET", url: "/api/audit", headers: { cookie: ownerCookie } })
    ).json();

    const reprice = body.events.find((event: { action: string }) => event.action === "reprice");

    assert.ok(reprice, "a reprice must be recorded separately from routine edits");
    assert.equal(reprice.reason, "Ajuste acordado con el cliente.");
    assert.equal(reprice.entityLabel, "A-01");
    assert.equal(reprice.actorName, "Owner");
    assert.equal(reprice.before.basePriceCents, 18_500_000);
    assert.equal(reprice.after.basePriceCents, 19_000_000);
  });

  it("returns newest first", async () => {
    const body = (
      await app.inject({ method: "GET", url: "/api/audit", headers: { cookie: ownerCookie } })
    ).json();

    const timestamps = body.events.map((event: { createdAt: string }) => event.createdAt);
    const sorted = [...timestamps].sort().reverse();

    assert.deepEqual(timestamps, sorted);
  });

  it("filters by entity type", async () => {
    const body = (
      await app.inject({
        method: "GET",
        url: "/api/audit?entityType=lot",
        headers: { cookie: ownerCookie },
      })
    ).json();

    assert.ok(body.events.length > 0);
    assert.ok(
      body.events.every((event: { entityType: string }) => event.entityType === "lot"),
      "every row must be a lot event",
    );
  });

  it("paginates", async () => {
    const first = (
      await app.inject({
        method: "GET",
        url: "/api/audit?limit=1&offset=0",
        headers: { cookie: ownerCookie },
      })
    ).json();

    const second = (
      await app.inject({
        method: "GET",
        url: "/api/audit?limit=1&offset=1",
        headers: { cookie: ownerCookie },
      })
    ).json();

    assert.equal(first.events.length, 1);
    assert.equal(second.events.length, 1);
    assert.notEqual(first.events[0].id, second.events[0].id);
    assert.ok(first.total > 1);
  });

  it("rejects a nonsense limit", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/audit?limit=9999",
      headers: { cookie: ownerCookie },
    });

    assert.equal(response.statusCode, 400);
  });
});
