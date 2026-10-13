import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";

import { and, desc, eq } from "drizzle-orm";

import { auditEvents, contracts, lots } from "../src/db/schema.js";
import { OWNER_PASSWORD, buildTestApp, login } from "./helpers.js";

const lempiras = (amount: number) => Math.round(amount * 100);

/**
 * Code review P3-1. «Editar términos» (PATCH /contracts/:id) can change a
 * contract's kind and expiry date, which decide whether it holds its lot. It
 * must obey the same rule as POST /contracts and reassign-lot: one holder per
 * lot. Before the fix, an expired reservation could be revived on top of a
 * later sale, and a signed contract could be turned into an already-expired
 * reservation, putting a paid-for lot back on sale.
 */
describe("editing terms (P3-1)", async () => {
  const { app, db, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const future = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);

  const addLot = (code: string) => {
    const id = randomUUID();
    db.insert(lots)
      .values({ id, projectId: ids.projectId, code, areaM2: 300, basePriceCents: lempiras(100_000) })
      .run();
    return id;
  };

  /** A reservation that lapsed long ago and, like every one, still reads status 'active'. */
  const addLapsedReservation = (lotId: string, code: string) => {
    const id = randomUUID();
    db.insert(contracts)
      .values({
        id,
        code,
        lotId,
        customerId: ids.customerId,
        kind: "reservation",
        saleType: "cash",
        status: "active",
        salePriceCents: lempiras(100_000),
        downPaymentCents: 0,
        signedOn: "2020-01-01",
        expiresOn: "2020-02-01",
      })
      .run();
    return id;
  };

  const sell = async (lotId: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/contracts",
      headers: { cookie },
      payload: {
        customerId: ids.customerId,
        lotId,
        kind: "contract",
        saleType: "cash",
        salePriceCents: lempiras(120_000),
        downPaymentCents: 0,
        signedOn: "2026-08-01",
      },
    });
    assert.equal(response.statusCode, 201, response.payload);
    return response.json().contract as { id: string; code: string };
  };

  const edit = (id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: `/api/contracts/${id}`,
      headers: { cookie },
      payload: {
        saleType: "cash",
        salePriceCents: lempiras(100_000),
        downPaymentCents: 0,
        signedOn: "2020-01-01",
        reason: "Corrección pedida por gerencia",
        ...payload,
      },
    });

  const holdersOf = async (lotCode: string) =>
    (await app.inject({ method: "GET", url: "/api/lots", headers: { cookie } }))
      .json()
      .lots.filter((row: { code: string }) => row.code === lotCode);

  it("refuses to extend a lapsed reservation over a later sale", async () => {
    const lotId = addLot("P31-A");
    const reservationId = addLapsedReservation(lotId, "CT-2020-101");
    const sale = await sell(lotId);

    const response = await edit(reservationId, { kind: "reservation", expiresOn: future });

    assert.equal(response.statusCode, 409, response.payload);
    assert.equal(response.json().error, "lot_taken");
    assert.match(response.json().message, new RegExp(sale.code));

    const rows = await holdersOf("P31-A");
    assert.equal(rows.length, 1, "the lot must be listed once");
    assert.equal(rows[0].holding.contractCode, sale.code);
  });

  it("refuses to convert a lapsed reservation into a contract over a later sale", async () => {
    const lotId = addLot("P31-B");
    const reservationId = addLapsedReservation(lotId, "CT-2020-102");
    await sell(lotId);

    const response = await edit(reservationId, { kind: "contract" });

    assert.equal(response.statusCode, 409, response.payload);
    assert.equal((await holdersOf("P31-B")).length, 1);
  });

  it("still lets a lapsed reservation be extended when nobody bought the lot", async () => {
    const lotId = addLot("P31-C");
    const reservationId = addLapsedReservation(lotId, "CT-2020-103");

    const response = await edit(reservationId, { kind: "reservation", expiresOn: future });

    assert.equal(response.statusCode, 200, response.payload);
    const rows = await holdersOf("P31-C");
    assert.equal(rows[0].holding.contractCode, "CT-2020-103");
  });

  it("still lets a lapsed reservation be edited while it stays lapsed", async () => {
    const lotId = addLot("P31-D");
    const reservationId = addLapsedReservation(lotId, "CT-2020-104");
    await sell(lotId);

    // A typo fixed on history: the reservation holds nothing before or after.
    const response = await edit(reservationId, {
      kind: "reservation",
      expiresOn: "2020-02-01",
      notes: "Nota corregida",
    });

    assert.equal(response.statusCode, 200, response.payload);
  });

  it("refuses to turn a signed contract back into a reservation", async () => {
    const lotId = addLot("P31-E");
    const sale = await sell(lotId);

    // An expiry date already past: the lot would read as available again.
    const response = await edit(sale.id, {
      kind: "reservation",
      salePriceCents: lempiras(120_000),
      signedOn: "2026-08-01",
      expiresOn: "2026-08-02",
    });

    assert.equal(response.statusCode, 400, response.payload);
    assert.equal(response.json().error, "invalid_terms");

    const rows = await holdersOf("P31-E");
    assert.equal(rows[0].holding.contractCode, sale.code, "the lot must stay sold");
  });

  it("records the expiry date and notes in the Historial", async () => {
    const lotId = addLot("P31-F");
    const reservationId = addLapsedReservation(lotId, "CT-2020-105");

    const response = await edit(reservationId, {
      kind: "reservation",
      expiresOn: future,
      notes: "Extendida una vez",
    });
    assert.equal(response.statusCode, 200, response.payload);

    const row = db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, "contract"), eq(auditEvents.entityId, reservationId)))
      .orderBy(desc(auditEvents.createdAt))
      .get();

    const before = JSON.parse(row!.beforeJson!);
    const afterEdit = JSON.parse(row!.afterJson!);
    assert.equal(before.expiresOn, "2020-02-01");
    assert.equal(afterEdit.expiresOn, future);
    assert.equal(before.notes, null);
    assert.equal(afterEdit.notes, "Extendida una vez");
  });
});
