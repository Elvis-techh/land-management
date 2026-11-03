import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";

import { auditEvents } from "../src/db/schema.js";
import { OWNER_PASSWORD, buildTestApp, login } from "./helpers.js";

/*
 * #6: search, filters and sort on the Historial. They run on the server,
 * because the screen reads the history a page at a time.
 */
describe("searching and filtering the change history", async () => {
  const { app, db, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  // A known history, with the two timestamp shapes the database really holds.
  sqlite.exec("DELETE FROM audit_events");
  const row = (
    label: string,
    values: Partial<typeof auditEvents.$inferInsert> & { createdAt: string },
  ) => {
    db.insert(auditEvents)
      .values({
        id: label,
        actorId: ids.ownerId,
        entityType: "lot",
        entityId: ids.heldLotId,
        action: "update",
        ...values,
      })
      .run();
  };
  // 10 Oct, 09:00 in Tegucigalpa.
  row("lot-edit", { createdAt: "2026-10-10 15:00:00" });
  // 10 Oct, 23:30 in Tegucigalpa: already 11 Oct in UTC.
  row("customer-edit", {
    actorId: ids.staffId,
    entityType: "customer",
    entityId: ids.customerId,
    createdAt: "2026-10-11T05:30:00.000Z",
  });
  // A receipt: nothing to join to, its customer is only in the snapshot.
  row("receipt-void", {
    entityType: "payment",
    entityId: randomUUID(),
    action: "reverse",
    beforeJson: JSON.stringify({ receiptCode: "R-0001", customerName: "Cliente Prueba" }),
    createdAt: "2026-10-12 18:00:00",
  });
  row("contract-cancel", {
    entityType: "contract",
    entityId: ids.contractId,
    action: "cancel",
    reason: "Se fue del país",
    createdAt: "2026-10-13 12:00:00",
  });

  const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const history = async (query: string) => {
    const response = await app.inject({ method: "GET", url: `/api/audit?${query}`, headers: { cookie } });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as { events: Array<{ id: string }>; total: number };
    return { ids: body.events.map((event) => event.id), total: body.total };
  };

  it("opens newest first, and turns around on request", async () => {
    assert.deepEqual((await history("")).ids, ["contract-cancel", "receipt-void", "customer-edit", "lot-edit"]);
    assert.deepEqual((await history("order=asc")).ids, ["lot-edit", "customer-edit", "receipt-void", "contract-cancel"]);
  });

  it("keeps two changes in the same second in the order they were made", async () => {
    // Written b, c, a: alphabetical order would get this wrong.
    row("same-second-b", { createdAt: "2026-10-14 10:00:00" });
    row("same-second-c", { createdAt: "2026-10-14 10:00:00" });
    row("same-second-a", { createdAt: "2026-10-14 10:00:00" });
    assert.deepEqual((await history("from=2026-10-14")).ids, ["same-second-a", "same-second-c", "same-second-b"]);
    assert.deepEqual((await history("from=2026-10-14&order=asc")).ids, ["same-second-b", "same-second-c", "same-second-a"]);
    sqlite.exec("DELETE FROM audit_events WHERE id LIKE 'same-second-%'");
  });

  it("filters by what changed, several kinds at once", async () => {
    assert.deepEqual((await history("entityTypes=lot,customer")).ids, ["customer-edit", "lot-edit"]);
  });

  it("filters by who made the change", async () => {
    assert.deepEqual((await history(`actorIds=${ids.staffId}`)).ids, ["customer-edit"]);
  });

  it("filters by business date, so 23:30 still counts as that day", async () => {
    assert.deepEqual((await history("from=2026-10-10&to=2026-10-10")).ids, ["customer-edit", "lot-edit"]);
    assert.deepEqual((await history("from=2026-10-11")).ids, ["contract-cancel", "receipt-void"]);
    assert.deepEqual((await history("to=2026-10-09")).ids, []);
  });

  it("searches what a change is about, its snapshots and its reason", async () => {
    // The customer's own row, and the receipt that names them.
    assert.deepEqual((await history("q=cliente%20prueba")).ids, ["receipt-void", "customer-edit"]);
    assert.deepEqual((await history("q=a-01")).ids, ["lot-edit"]);
    assert.deepEqual((await history("q=CT-TEST-001")).ids, ["contract-cancel"]);
    assert.deepEqual((await history("q=pa%C3%ADs")).ids, ["contract-cancel"]);
  });

  it("treats % and _ as plain characters", async () => {
    assert.deepEqual((await history("q=%25")).ids, []);
    assert.deepEqual((await history("q=_")).ids, []);
  });

  it("counts only what matches, so the pages add up", async () => {
    assert.equal((await history("entityTypes=lot,customer&limit=1")).total, 2);
    assert.equal((await history("q=prueba&limit=1")).total, 2);
    assert.equal((await history("")).total, 4);
  });

  it("refuses a malformed date", async () => {
    const response = await app.inject({ method: "GET", url: "/api/audit?from=10/10/2026", headers: { cookie } });
    assert.equal(response.statusCode, 400);
  });

  it("lists who has made changes, for the «Quién» filter", async () => {
    const response = await app.inject({ method: "GET", url: "/api/audit/actors", headers: { cookie } });
    assert.deepEqual(
      response.json().actors.map((actor: { name: string }) => actor.name),
      ["Owner", "Staff"],
    );
  });
});
