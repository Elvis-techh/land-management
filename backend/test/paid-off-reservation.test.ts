import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";

import { contracts, lots } from "../src/db/schema.js";
import { OWNER_PASSWORD, buildTestApp, login } from "./helpers.js";

const lempiras = (amount: number) => Math.round(amount * 100);

/**
 * Code review P3-3. A reservation paid in full (`paid_off`) is a sale in all
 * but name. Before the fix its expiry date still released the lot: the lot
 * could be sold to someone else with the first customer's money already in,
 * and three screens disagreed about it (Lotes held, Proyectos available).
 */
describe("a reservation paid in full (P3-3)", async () => {
  const { app, db, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

  const lotId = randomUUID();
  db.insert(lots)
    .values({ id: lotId, projectId: ids.projectId, code: "P33-A", areaM2: 300, basePriceCents: lempiras(50_000) })
    .run();

  // Paid off long ago, with an expiry date long past.
  db.insert(contracts)
    .values({
      id: randomUUID(),
      code: "CT-2020-201",
      lotId,
      customerId: ids.customerId,
      kind: "reservation",
      saleType: "cash",
      status: "paid_off",
      salePriceCents: lempiras(50_000),
      downPaymentCents: 0,
      signedOn: "2020-01-01",
      expiresOn: "2020-02-01",
    })
    .run();

  const get = async (url: string) =>
    (await app.inject({ method: "GET", url, headers: { cookie } })).json();

  it("keeps holding its lot after its date", async () => {
    const lot = (await get("/api/lots")).lots.find((row: { code: string }) => row.code === "P33-A");
    assert.equal(lot.holding?.contractCode, "CT-2020-201");
  });

  it("is not shown as «Vencida» on Contratos", async () => {
    const contract = (await get("/api/contracts")).contracts.find(
      (row: { code: string }) => row.code === "CT-2020-201",
    );
    assert.equal(contract.expired, false);
  });

  // Before the sale attempt below: on the old code that sale went through and
  // would have made these counts look right.
  it("counts as sold on Proyectos, not as available", async () => {
    const project = (await get("/api/projects")).projects.find(
      (row: { id: string }) => row.id === ids.projectId,
    );

    // The seed: A-01 held by an active reservation, A-02 free. Plus P33-A.
    assert.equal(project.lotCount, 3);
    assert.equal(project.soldCount, 1);
    assert.equal(project.availableCount, 1);
    assert.equal(project.reservedCount, 1);
  });

  it("blocks a second sale of the lot", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/contracts",
      headers: { cookie },
      payload: {
        customerId: ids.customerId,
        lotId,
        kind: "contract",
        saleType: "cash",
        salePriceCents: lempiras(60_000),
        downPaymentCents: 0,
        signedOn: "2026-08-01",
      },
    });

    assert.equal(response.statusCode, 409, response.payload);
    assert.equal(response.json().error, "lot_taken");
  });
});
