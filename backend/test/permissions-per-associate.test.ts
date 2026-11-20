import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";

import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

/*
 * QI-5 step 3: one associate can be given a list of permissions of their own,
 * while every other associate keeps following the general Permisos screen.
 */
describe("permissions for one associate", async () => {
  const { app, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

  // A second associate, who must keep following the general list throughout.
  // The password is made up at run time, so no secret is written in the code.
  const otherPassword = randomUUID();
  const created = await app.inject({
    method: "POST",
    url: "/api/users",
    headers: { cookie: ownerCookie },
    payload: { name: "Otra Asociada", email: "otra@test.hn", role: "staff", password: otherPassword },
  });
  assert.equal(created.statusCode, 201, created.body);
  const otherId: string = created.json().user.id;
  const otherCookie = await login(app, "otra@test.hn", otherPassword);

  const readFor = (cookie: string, userId: string) =>
    app.inject({ method: "GET", url: `/api/permissions/users/${userId}`, headers: { cookie } });

  const saveFor = (cookie: string, userId: string, payload: unknown) =>
    app.inject({
      method: "PUT",
      url: `/api/permissions/users/${userId}`,
      headers: { cookie },
      payload: payload as Record<string, unknown>,
    });

  const myCapabilities = async (cookie: string): Promise<string[]> =>
    (await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).json().user
      .capabilities;

  const archiveLot = (cookie: string, lotId: string) =>
    app.inject({
      method: "POST",
      url: `/api/lots/${lotId}/archive`,
      headers: { cookie },
      payload: { reason: "Lote duplicado por error de captura." },
    });

  const createLot = (cookie: string, code: string) =>
    app.inject({
      method: "POST",
      url: "/api/lots",
      headers: { cookie },
      payload: { code, projectName: "Proyecto Prueba", areaM2: 250, basePriceCents: 15_000_000 },
    });

  const permissionEvents = async () =>
    (await app.inject({ method: "GET", url: "/api/audit", headers: { cookie: ownerCookie } }))
      .json()
      .events.filter((event: { entityType: string }) => event.entityType === "role");

  it("is closed to the associate, like the rest of Permisos", async () => {
    assert.equal((await readFor(staffCookie, ids.staffId)).statusCode, 403);
    assert.equal(
      (await saveFor(staffCookie, ids.staffId, { mode: "own", capabilities: ["lot:archive"] }))
        .statusCode,
      403,
    );
  });

  it("lists the associates, all following the general list at first", async () => {
    const body = (
      await app.inject({ method: "GET", url: "/api/permissions", headers: { cookie: ownerCookie } })
    ).json();

    assert.deepEqual(
      body.associates.map((associate: { name: string; ownPermissions: boolean }) => [
        associate.name,
        associate.ownPermissions,
      ]),
      [
        ["Otra Asociada", false],
        ["Staff", false],
      ],
    );

    const person = (await readFor(ownerCookie, ids.staffId)).json();
    assert.equal(person.mode, "general");
    assert.equal(person.user.name, "Staff");
    const lotCreate = person.capabilities.find(
      (row: { capability: string }) => row.capability === "lot:create",
    );
    assert.deepEqual(lotCreate, { capability: "lot:create", enabled: true, general: true });
  });

  it("gives one associate a power the others don't have, on their next request", async () => {
    // Not a general permission, so both associates are refused first.
    assert.equal((await archiveLot(staffCookie, ids.freeLotId)).statusCode, 403);

    const saved = await saveFor(ownerCookie, ids.staffId, {
      mode: "own",
      // The defaults, minus «Crear lotes», plus «Archivar lotes».
      capabilities: ["customer:create", "customer:edit", "contract:create", "payment:record", "lot:archive"],
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().mode, "own");

    // Same session, no new login.
    assert.equal((await archiveLot(staffCookie, ids.freeLotId)).statusCode, 200);
    assert.equal((await createLot(staffCookie, "OWN-1")).statusCode, 403);

    // The other associate still follows the general list: refused to archive,
    // allowed to create a lot.
    assert.equal((await archiveLot(otherCookie, ids.heldLotId)).statusCode, 403);
    assert.equal((await createLot(otherCookie, "GEN-1")).statusCode, 201);

    // What the screens are told, so they show and hide the right buttons.
    const mine = await myCapabilities(staffCookie);
    assert.equal(mine.includes("lot:archive"), true);
    assert.equal(mine.includes("lot:create"), false);
    assert.equal((await myCapabilities(otherCookie)).includes("lot:archive"), false);

    // The screen marks the switches that differ from the general list.
    const person = (await readFor(ownerCookie, ids.staffId)).json();
    assert.equal(person.mode, "own");
    const differ = person.capabilities
      .filter((row: { enabled: boolean; general: boolean }) => row.enabled !== row.general)
      .map((row: { capability: string }) => row.capability)
      .sort();
    assert.deepEqual(differ, ["lot:archive", "lot:create"]);
  });

  it("records the change in the Historial, against the person", async () => {
    const [event] = await permissionEvents();

    assert.equal(event.entityId, ids.staffId);
    assert.equal(event.entityLabel, "Staff");
    assert.equal(event.before.permissionMode, "general");
    assert.equal(event.after.permissionMode, "own");
    assert.equal(event.before.capabilities.includes("lot:create"), true);
    assert.equal(event.after.capabilities.includes("lot:create"), false);
    assert.equal(event.after.capabilities.includes("lot:archive"), true);
  });

  it("writes nothing when saved again unchanged", async () => {
    const countBefore = (await permissionEvents()).length;
    const again = await saveFor(ownerCookie, ids.staffId, {
      mode: "own",
      capabilities: ["lot:archive", "payment:record", "contract:create", "customer:edit", "customer:create"],
    });
    assert.equal(again.statusCode, 200);
    assert.equal((await permissionEvents()).length, countBefore);
  });

  it("keeps an associate with their own list out of a later general change", async () => {
    const general = await app.inject({
      method: "PUT",
      url: "/api/permissions",
      headers: { cookie: ownerCookie },
      payload: { capabilities: ["lot:create", "customer:create", "customer:edit", "contract:create", "payment:record", "rate:edit"] },
    });
    assert.equal(general.statusCode, 200);

    assert.equal((await myCapabilities(otherCookie)).includes("rate:edit"), true);
    assert.equal((await myCapabilities(staffCookie)).includes("rate:edit"), false);
  });

  it("says who has a list of their own, on Permisos and on Usuarios", async () => {
    const permissions = (
      await app.inject({ method: "GET", url: "/api/permissions", headers: { cookie: ownerCookie } })
    ).json();
    const own = permissions.associates
      .filter((associate: { ownPermissions: boolean }) => associate.ownPermissions)
      .map((associate: { name: string }) => associate.name);
    assert.deepEqual(own, ["Staff"]);

    const accounts = (
      await app.inject({ method: "GET", url: "/api/users", headers: { cookie: ownerCookie } })
    ).json().users;
    const flags = Object.fromEntries(
      accounts.map((account: { name: string; ownPermissions: boolean }) => [account.name, account.ownPermissions]),
    );
    assert.deepEqual(flags, { "Otra Asociada": false, Owner: false, Staff: true });
  });

  it("puts the associate back on the general list", async () => {
    const back = await saveFor(ownerCookie, ids.staffId, { mode: "general" });
    assert.equal(back.statusCode, 200);

    const mine = await myCapabilities(staffCookie);
    assert.equal(mine.includes("rate:edit"), true);
    assert.equal(mine.includes("lot:create"), true);
    assert.equal(mine.includes("lot:archive"), false);
    assert.equal((await readFor(ownerCookie, ids.staffId)).json().mode, "general");

    const [event] = await permissionEvents();
    assert.equal(event.entityId, ids.staffId);
    assert.equal(event.before.permissionMode, "own");
    assert.equal(event.after.permissionMode, "general");
  });

  it("refuses what can never be handed over, and what makes no sense", async () => {
    const locked = await saveFor(ownerCookie, ids.staffId, { mode: "own", capabilities: ["permission:manage"] });
    assert.equal(locked.statusCode, 400);
    assert.equal(locked.json().error, "locked_capability");

    const mora = await saveFor(ownerCookie, ids.staffId, { mode: "own", capabilities: ["mora:edit"] });
    assert.equal(mora.json().error, "locked_capability");

    const unknown = await saveFor(ownerCookie, ids.staffId, { mode: "own", capabilities: ["lot:teleport"] });
    assert.equal(unknown.json().error, "unknown_capability");

    const badMode = await saveFor(ownerCookie, ids.staffId, { mode: "everything" });
    assert.equal(badMode.statusCode, 400);

    const supervisor = await saveFor(ownerCookie, ids.ownerId, { mode: "own", capabilities: [] });
    assert.equal(supervisor.statusCode, 400);
    assert.equal(supervisor.json().error, "not_an_associate");

    const nobody = await readFor(ownerCookie, randomUUID());
    assert.equal(nobody.statusCode, 404);
  });

  it("clears an associate's own list when their role changes", async () => {
    const own = await saveFor(ownerCookie, otherId, { mode: "own", capabilities: ["payment:record"] });
    assert.equal(own.statusCode, 200);

    const promote = (role: string) =>
      app.inject({
        method: "PATCH",
        url: `/api/users/${otherId}`,
        headers: { cookie: ownerCookie },
        payload: { name: "Otra Asociada", email: "otra@test.hn", role },
      });

    assert.equal((await promote("owner")).statusCode, 200);
    assert.equal((await promote("staff")).statusCode, 200);

    // Back as an associate, she follows the general list, not the old one.
    const person = (await readFor(ownerCookie, otherId)).json();
    assert.equal(person.mode, "general");
    assert.equal((await myCapabilities(otherCookie)).includes("lot:create"), true);

    // The role change that cleared it says so.
    const events = (
      await app.inject({ method: "GET", url: "/api/audit", headers: { cookie: ownerCookie } })
    ).json().events;
    const promotion = events.find(
      (event: { entityType: string; entityId: string; after: { role?: string } }) =>
        event.entityType === "user" && event.entityId === otherId && event.after?.role === "owner",
    );
    assert.equal(promotion.before.permissionMode, "own");
    assert.equal(promotion.after.permissionMode, "general");
  });
});
