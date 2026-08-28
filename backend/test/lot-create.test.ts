import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

describe("creating a lot", async () => {
  const { app, sqlite } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

  const create = (cookie: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/lots", headers: { cookie }, payload });

  const validLot = {
    code: "A-03",
    projectName: "Proyecto Prueba",
    areaM2: 320,
    basePriceCents: 17_000_000,
  };

  it("refuses an anonymous request", async () => {
    const response = await app.inject({ method: "POST", url: "/api/lots", payload: validLot });
    assert.equal(response.statusCode, 401);
  });

  it("creates the lot and returns it", async () => {
    const response = await create(ownerCookie, validLot);

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().lot.code, "A-03");
  });

  it("makes the new lot available, with no client", async () => {
    const lots = (
      await app.inject({ method: "GET", url: "/api/lots", headers: { cookie: ownerCookie } })
    ).json().lots;

    const created = lots.find((lot: { code: string }) => lot.code === "A-03");
    assert.equal(created.holding, null);
    assert.equal(created.basePrice, 17_000_000);
  });

  it("files the creation in the history", async () => {
    const events = (
      await app.inject({ method: "GET", url: "/api/audit", headers: { cookie: ownerCookie } })
    ).json().events;

    const created = events.find(
      (event: { action: string; entityType: string }) =>
        event.action === "create" && event.entityType === "lot",
    );
    assert.ok(created, "the new lot should appear in the audit history");
  });

  it("refuses a lot number that already exists in the project", async () => {
    const response = await create(ownerCookie, { ...validLot, code: "A-01" });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "duplicate_code");
    assert.match(response.json().message, /A-01/);
  });

  it("refuses a project that does not exist", async () => {
    const response = await create(ownerCookie, { ...validLot, code: "Z-01", projectName: "Nada" });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "unknown_project");
  });

  it("refuses an area of zero and a negative price", async () => {
    const zeroArea = await create(ownerCookie, { ...validLot, code: "Z-02", areaM2: 0 });
    assert.equal(zeroArea.statusCode, 400);

    const negative = await create(ownerCookie, { ...validLot, code: "Z-03", basePriceCents: -1 });
    assert.equal(negative.statusCode, 400);
  });

  it("lets staff add a lot — day-to-day work, not history", async () => {
    const response = await create(staffCookie, { ...validLot, code: "B-01" });
    assert.equal(response.statusCode, 201);
  });
});
