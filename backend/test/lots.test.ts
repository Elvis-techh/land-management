import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { auditEvents, lots } from "../src/db/schema.js";
import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

describe("lots", async () => {
  const { app, db, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

  const listLots = async (cookie: string) =>
    app.inject({ method: "GET", url: "/api/lots", headers: { cookie } });

  it("refuses to list lots without a session", async () => {
    const response = await app.inject({ method: "GET", url: "/api/lots" });
    assert.equal(response.statusCode, 401);
  });

  it("lets any signed-in user read the inventory", async () => {
    for (const cookie of [ownerCookie, staffCookie]) {
      const response = await listLots(cookie);
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().lots.length, 2);
    }
  });

  it("sums paid-to-date from the payments table rather than storing it", async () => {
    const body = (await listLots(ownerCookie)).json();
    const held = body.lots.find((lot: { code: string }) => lot.code === "A-01");

    // Two seeded payments: L. 10,000.00 + L. 5,000.00
    assert.equal(held.holding.paidToDate, 1_500_000);
    assert.equal(held.holding.contractCode, "CT-TEST-001");
  });

  it("reports a lot with no contract as unheld", async () => {
    const body = (await listLots(ownerCookie)).json();
    const free = body.lots.find((lot: { code: string }) => lot.code === "A-02");

    assert.equal(free.holding, null);
  });

  describe("editing", () => {
    const validEdit = {
      code: "A-02",
      projectName: "Proyecto Prueba",
      areaM2: 333,
      basePriceCents: 16_000_000,
    };

    it("forbids staff from editing, even though the UI hides the button", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/lots/${ids.freeLotId}`,
        headers: { cookie: staffCookie },
        payload: validEdit,
      });

      assert.equal(response.statusCode, 403);

      // And nothing changed.
      const row = db.select().from(lots).where(eq(lots.id, ids.freeLotId)).get();
      assert.equal(row?.areaM2, 280);
    });

    it("lets an owner correct an area", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/lots/${ids.freeLotId}`,
        headers: { cookie: ownerCookie },
        payload: validEdit,
      });

      assert.equal(response.statusCode, 200);

      const row = db.select().from(lots).where(eq(lots.id, ids.freeLotId)).get();
      assert.equal(row?.areaM2, 333);
    });

    it("will not silently reprice a lot that is under contract", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/lots/${ids.heldLotId}`,
        headers: { cookie: ownerCookie },
        payload: {
          code: "A-01",
          projectName: "Proyecto Prueba",
          areaM2: 300,
          basePriceCents: 1,
        },
      });

      // Repricing is allowed — prices really do get renegotiated — but not
      // without a written reason, and not without leaving a trace.
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, "reason_required");

      const row = db.select().from(lots).where(eq(lots.id, ids.heldLotId)).get();
      assert.equal(row?.basePriceCents, 18_500_000);
    });

    it("edits a contracted lot's area without demanding a reason", async () => {
      // Only the PRICE is consequential. Correcting an area is routine.
      const response = await app.inject({
        method: "PATCH",
        url: `/api/lots/${ids.heldLotId}`,
        headers: { cookie: ownerCookie },
        payload: {
          code: "A-01",
          projectName: "Proyecto Prueba",
          areaM2: 312,
          basePriceCents: 18_500_000,
        },
      });

      assert.equal(response.statusCode, 200);

      const row = db.select().from(lots).where(eq(lots.id, ids.heldLotId)).get();
      assert.equal(row?.areaM2, 312);
    });

    it("rejects a negative area", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/lots/${ids.freeLotId}`,
        headers: { cookie: ownerCookie },
        payload: { ...validEdit, areaM2: -5 },
      });

      assert.equal(response.statusCode, 400);
    });

    it("rejects an unknown project", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/lots/${ids.freeLotId}`,
        headers: { cookie: ownerCookie },
        payload: { ...validEdit, projectName: "Proyecto Inventado" },
      });

      assert.equal(response.statusCode, 400);
    });

    it("refuses to rename a lot on to a number already used in the project", async () => {
      // A-01 belongs to the other lot. Before this was checked the write
      // reached SQLite and came back as "UNIQUE constraint failed:
      // lots.project_id, lots.code", which reached the user's screen verbatim.
      const response = await app.inject({
        method: "PATCH",
        url: `/api/lots/${ids.freeLotId}`,
        headers: { cookie: ownerCookie },
        payload: { ...validEdit, code: "A-01" },
      });

      assert.equal(response.statusCode, 409);
      assert.equal(response.json().error, "duplicate_code");

      // The refusal has to name the lot and the project, in Spanish, with no
      // trace of the column names behind it.
      const { message } = response.json();
      assert.match(message, /A-01/);
      assert.match(message, /Proyecto Prueba/);
      assert.doesNotMatch(message, /UNIQUE|constraint|project_id/i);

      const row = db.select().from(lots).where(eq(lots.id, ids.freeLotId)).get();
      assert.equal(row?.code, "A-02");
    });

    it("does not mistake a lot for a duplicate of itself", async () => {
      // Editing the area while leaving the number alone is the commonest edit
      // there is; a self-clash here would block it entirely.
      const response = await app.inject({
        method: "PATCH",
        url: `/api/lots/${ids.freeLotId}`,
        headers: { cookie: ownerCookie },
        payload: { ...validEdit, areaM2: 334 },
      });

      assert.equal(response.statusCode, 200);
    });

    it("returns 404 for a lot that does not exist", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/lots/00000000-0000-0000-0000-000000000000",
        headers: { cookie: ownerCookie },
        payload: validEdit,
      });

      assert.equal(response.statusCode, 404);
    });

    it("writes an audit row with before and after values", async () => {
      const rows = db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.entityId, ids.freeLotId))
        .all();

      const update = rows.find((row) => row.action === "update");
      assert.ok(update, "an update must be audited");
      assert.equal(update.actorId, ids.ownerId);
      assert.equal(JSON.parse(update.beforeJson!).areaM2, 280);
      assert.equal(JSON.parse(update.afterJson!).areaM2, 333);
    });
  });

  describe("archiving", () => {
    const reason = { reason: "Lote duplicado por error de captura." };

    it("forbids staff from archiving", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/lots/${ids.freeLotId}/archive`,
        headers: { cookie: staffCookie },
        payload: reason,
      });

      assert.equal(response.statusCode, 403);
    });

    it("refuses to archive a lot that has an active contract", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/lots/${ids.heldLotId}/archive`,
        headers: { cookie: ownerCookie },
        payload: reason,
      });

      assert.equal(response.statusCode, 409);
      assert.equal(response.json().error, "lot_has_contract");
    });

    it("requires a real reason", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/lots/${ids.freeLotId}/archive`,
        headers: { cookie: ownerCookie },
        payload: { reason: "x" },
      });

      assert.equal(response.statusCode, 400);
    });

    it("archives an unheld lot, keeping the row and the reason", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/lots/${ids.freeLotId}/archive`,
        headers: { cookie: ownerCookie },
        payload: reason,
      });

      assert.equal(response.statusCode, 200);

      // Archived, not deleted: the row is still there, with its reason.
      const row = db.select().from(lots).where(eq(lots.id, ids.freeLotId)).get();
      assert.ok(row, "the lot row must survive archiving");
      assert.ok(row.archivedAt);
      assert.equal(row.archiveReason, reason.reason);

      // And it has left the working inventory.
      const body = (await listLots(ownerCookie)).json();
      assert.equal(body.lots.length, 1);
      assert.equal(body.lots.some((lot: { code: string }) => lot.code === "A-02"), false);
    });

    it("records the archive reason in the audit trail", async () => {
      const rows = db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.entityId, ids.freeLotId))
        .all();

      const archived = rows.find((row) => row.action === "archive");
      assert.ok(archived);
      assert.equal(archived.reason, reason.reason);
    });

    it("will not archive the same lot twice", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/lots/${ids.freeLotId}/archive`,
        headers: { cookie: ownerCookie },
        payload: reason,
      });

      assert.equal(response.statusCode, 404);
    });
  });

  describe("restoring an archived lot", () => {
    // ids.freeLotId ("A-02") was archived in the block above.
    it("brings it back into the working inventory", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/lots/${ids.freeLotId}/restore`,
        headers: { cookie: ownerCookie },
      });

      assert.equal(response.statusCode, 200);

      const row = db.select().from(lots).where(eq(lots.id, ids.freeLotId)).get();
      assert.equal(row?.archivedAt, null);
      assert.equal(row?.archiveReason, null);

      const body = (await listLots(ownerCookie)).json();
      assert.equal(body.lots.some((lot: { code: string }) => lot.code === "A-02"), true);
    });

    it("records the restore in the audit trail", async () => {
      const restored = db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.entityId, ids.freeLotId))
        .all()
        .find((row) => row.action === "restore");

      assert.ok(restored, "a restore must be audited");
    });

    it("forbids staff from restoring", async () => {
      // Archive it again first (as owner), then try to restore as staff.
      await app.inject({
        method: "POST",
        url: `/api/lots/${ids.freeLotId}/archive`,
        headers: { cookie: ownerCookie },
        payload: { reason: "Archivado de nuevo para la prueba." },
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/lots/${ids.freeLotId}/restore`,
        headers: { cookie: staffCookie },
      });

      assert.equal(response.statusCode, 403);
    });

    it("404s for a lot that is not archived", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/lots/${ids.heldLotId}/restore`,
        headers: { cookie: ownerCookie },
      });

      assert.equal(response.statusCode, 404);
    });
  });
});
