import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

describe("editing what the associate role may do", async () => {
  const { app, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

  const setCapabilities = (cookie: string, capabilities: string[]) =>
    app.inject({
      method: "PUT",
      url: "/api/permissions",
      headers: { cookie },
      payload: { capabilities },
    });

  const createLotAsStaff = (code: string) =>
    app.inject({
      method: "POST",
      url: "/api/lots",
      headers: { cookie: staffCookie },
      payload: {
        code,
        projectName: "Proyecto Prueba",
        areaM2: 250,
        basePriceCents: 15_000_000,
      },
    });

  it("hides the screen from the associate entirely", async () => {
    const read = await app.inject({
      method: "GET",
      url: "/api/permissions",
      headers: { cookie: staffCookie },
    });
    assert.equal(read.statusCode, 403);

    const write = await setCapabilities(staffCookie, ["lot:archive"]);
    assert.equal(write.statusCode, 403);
  });

  it("starts from the built-in defaults when nothing has been configured", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/permissions",
      headers: { cookie: ownerCookie },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    const enabled = body.capabilities
      .filter((row: { enabled: boolean }) => row.enabled)
      .map((row: { capability: string }) => row.capability);

    assert.deepEqual(enabled.sort(), [
      "contract:create",
      "customer:create",
      "customer:edit",
      "lot:create",
      "payment:record",
    ]);

    // Account control is never offered as a switch.
    const offered = body.capabilities.map((row: { capability: string }) => row.capability);
    assert.equal(offered.includes("user:manage"), false);
    assert.equal(offered.includes("permission:manage"), false);
    assert.deepEqual(body.locked.sort(), ["permission:manage", "user:manage"]);
  });

  it("refuses to hand over account control, loudly", async () => {
    const escalation = await setCapabilities(ownerCookie, ["lot:create", "permission:manage"]);
    assert.equal(escalation.statusCode, 400);
    assert.equal(escalation.json().error, "locked_capability");

    const users = await setCapabilities(ownerCookie, ["user:manage"]);
    assert.equal(users.statusCode, 400);
    assert.equal(users.json().error, "locked_capability");

    const nonsense = await setCapabilities(ownerCookie, ["lot:teleport"]);
    assert.equal(nonsense.statusCode, 400);
    assert.equal(nonsense.json().error, "unknown_capability");
  });

  it("grants a new capability that takes effect on the associate's next request", async () => {
    // Archiving is not a staff default, so this is refused first.
    const before = await app.inject({
      method: "POST",
      url: `/api/lots/${ids.freeLotId}/archive`,
      headers: { cookie: staffCookie },
      payload: { reason: "Lote duplicado por error de captura." },
    });
    assert.equal(before.statusCode, 403);

    const granted = await setCapabilities(ownerCookie, [
      "lot:create",
      "lot:archive",
      "customer:create",
      "customer:edit",
      "contract:create",
      "payment:record",
    ]);
    assert.equal(granted.statusCode, 200);

    // Same session, same cookie — no re-login.
    const afterGrant = await app.inject({
      method: "POST",
      url: `/api/lots/${ids.freeLotId}/archive`,
      headers: { cookie: staffCookie },
      payload: { reason: "Lote duplicado por error de captura." },
    });
    assert.equal(afterGrant.statusCode, 200);
  });

  it("revokes one immediately, mid-session", async () => {
    const allowed = await createLotAsStaff("S-01");
    assert.equal(allowed.statusCode, 201);

    await setCapabilities(ownerCookie, ["customer:create", "payment:record"]);

    const refused = await createLotAsStaff("S-02");
    assert.equal(refused.statusCode, 403);
  });

  it("reports the effective capabilities to the signed-in user", async () => {
    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: staffCookie },
    });

    assert.deepEqual(me.json().user.capabilities.sort(), ["customer:create", "payment:record"]);

    // The owner is not configurable and keeps everything.
    const ownerMe = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: ownerCookie },
    });
    assert.equal(ownerMe.json().user.capabilities.includes("permission:manage"), true);
    assert.equal(ownerMe.json().user.capabilities.includes("lot:archive"), true);
  });

  it("files every permission change in the history, with before and after", async () => {
    const events = (
      await app.inject({ method: "GET", url: "/api/audit", headers: { cookie: ownerCookie } })
    ).json().events;

    const change = events.find((event: { entityType: string }) => event.entityType === "role");

    assert.ok(change, "a permission change should appear in the history");
    assert.equal(change.action, "update");
    assert.ok(Array.isArray(change.after.capabilities));
  });

  it("can revoke everything without breaking the associate's session", async () => {
    const cleared = await setCapabilities(ownerCookie, []);
    assert.equal(cleared.statusCode, 200);

    // Still signed in, still able to read — reading is not a capability.
    const lots = await app.inject({
      method: "GET",
      url: "/api/lots",
      headers: { cookie: staffCookie },
    });
    assert.equal(lots.statusCode, 200);

    const write = await createLotAsStaff("S-03");
    assert.equal(write.statusCode, 403);
  });
});
