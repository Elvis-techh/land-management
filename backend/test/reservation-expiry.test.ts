import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { contracts, lots } from "../src/db/schema.js";
import { OWNER_PASSWORD, buildTestApp, login } from "./helpers.js";

const lempiras = (amount: number) => Math.round(amount * 100);

/**
 * A reservation is the one contract kind required to carry an `expiresOn`, and
 * the whole point of that date is that the hold LAPSES on it. Nothing sweeps
 * expired reservations to a closed status; like every other status in this app,
 * "the hold is over" is derived on read — so a reservation dated last year no
 * longer holds its lot, and the lot can be sold without a manual cancellation
 * that staff do not have the capability for.
 */
describe("an expired reservation", async () => {
  const { app, db, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

  const lotId = randomUUID();
  db.insert(lots)
    .values({ id: lotId, projectId: ids.projectId, code: "R-01", areaM2: 300, basePriceCents: lempiras(100_000) })
    .run();

  // A reservation that expired more than a year ago, still sitting at
  // status = 'active' because nothing ever closes one.
  const staleReservationId = randomUUID();
  db.insert(contracts)
    .values({
      id: staleReservationId,
      code: "CT-2020-001",
      lotId,
      customerId: ids.customerId,
      kind: "reservation",
      saleType: "financed",
      status: "active",
      salePriceCents: lempiras(100_000),
      downPaymentCents: lempiras(10_000),
      termMonths: 12,
      monthlyPaymentCents: lempiras(7_500),
      dueDay: 1,
      signedOn: "2020-01-01",
      expiresOn: "2020-02-01",
    })
    .run();

  const lotsList = async () =>
    (await app.inject({ method: "GET", url: "/api/lots", headers: { cookie: ownerCookie } })).json()
      .lots;

  it("no longer holds its lot — the lot reads as available", async () => {
    const lot = (await lotsList()).find((row: { code: string }) => row.code === "R-01");

    assert.equal(lot.holding, null, "an expired reservation must not hold the lot");
  });

  it("shows as 'vencida' on the contracts screen without being rewritten", async () => {
    const contract = (
      await app.inject({ method: "GET", url: "/api/contracts", headers: { cookie: ownerCookie } })
    )
      .json()
      .contracts.find((row: { code: string }) => row.code === "CT-2020-001");

    assert.equal(contract.expired, true);
    // The row itself is untouched — nothing swept it.
    const stored = db
      .select({ status: contracts.status })
      .from(contracts)
      .where(eq(contracts.id, staleReservationId))
      .get();
    assert.equal(stored?.status, "active");
  });

  it("does not block a real sale of the same lot", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/contracts",
      headers: { cookie: ownerCookie },
      payload: {
        customerId: ids.customerId,
        lotId,
        kind: "contract",
        saleType: "cash",
        salePriceCents: lempiras(120_000),
        downPaymentCents: lempiras(120_000),
        signedOn: "2026-08-01",
      },
    });

    assert.equal(response.statusCode, 201, response.payload);

    // And now the lot is held by the real contract, exactly once.
    const lot = (await lotsList()).find((row: { code: string }) => row.code === "R-01");
    assert.equal(lot.holding.contractCode, response.json().contract.code);
  });

  it("keeps a reservation that has NOT expired holding its lot", async () => {
    const freshLotId = randomUUID();
    db.insert(lots)
      .values({ id: freshLotId, projectId: ids.projectId, code: "R-02", areaM2: 300, basePriceCents: lempiras(100_000) })
      .run();

    const future = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);

    const made = await app.inject({
      method: "POST",
      url: "/api/contracts",
      headers: { cookie: ownerCookie },
      payload: {
        customerId: ids.customerId,
        lotId: freshLotId,
        kind: "reservation",
        saleType: "financed",
        salePriceCents: lempiras(100_000),
        downPaymentCents: lempiras(10_000),
        termMonths: 12,
        monthlyPaymentCents: lempiras(7_500),
        dueDay: 1,
        signedOn: "2026-01-01",
        expiresOn: future,
      },
    });

    assert.equal(made.statusCode, 201, made.payload);

    const lot = (await lotsList()).find((row: { code: string }) => row.code === "R-02");
    assert.equal(lot.holding.kind, "reservation");
  });
});
