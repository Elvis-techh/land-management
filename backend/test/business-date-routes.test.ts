import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it, mock } from "node:test";

import { contracts, lots } from "../src/db/schema.js";
import { OWNER_PASSWORD, buildTestApp, login } from "./helpers.js";

/**
 * Code review P3-5. Four route files (lots, customers, projects, transactions)
 * took "today" from UTC, so from 18:00 in Tegucigalpa they already lived in
 * tomorrow while POST /contracts used the office's date. At 23:30 local, a
 * reservation valid through today showed the lot as free on Lotes while the
 * sale of that same lot was refused.
 */
describe("the office's date on every screen (P3-5)", async () => {
  // 23:30 on 5 October in Tegucigalpa; already 6 October in UTC.
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-06T05:30:00Z") });

  const { app, db, sqlite, ids } = await buildTestApp();
  after(async () => {
    mock.timers.reset();
    await app.close();
    sqlite.close();
  });

  const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

  const lotId = randomUUID();
  db.insert(lots)
    .values({ id: lotId, projectId: ids.projectId, code: "P35-A", areaM2: 300, basePriceCents: 10_000_000 })
    .run();

  // Valid through today, the 5th, in the office.
  db.insert(contracts)
    .values({
      id: randomUUID(),
      code: "CT-2026-501",
      lotId,
      customerId: ids.customerId,
      kind: "reservation",
      saleType: "cash",
      status: "active",
      salePriceCents: 10_000_000,
      downPaymentCents: 0,
      signedOn: "2026-10-01",
      expiresOn: "2026-10-05",
    })
    .run();

  const get = async (url: string) =>
    (await app.inject({ method: "GET", url, headers: { cookie } })).json();

  it("Lotes still shows the lot as reserved", async () => {
    const lot = (await get("/api/lots")).lots.find((row: { code: string }) => row.code === "P35-A");
    assert.notEqual(lot.holding, null);
  });

  it("Proyectos still counts it as reserved", async () => {
    const project = (await get("/api/projects")).projects.find(
      (row: { id: string }) => row.id === ids.projectId,
    );
    // The seed's own reservation on A-01, plus this one.
    assert.equal(project.reservedCount, 2);
  });

  it("Clientes still lists it among the customer's holdings", async () => {
    const customer = (await get("/api/customers")).customers.find(
      (row: { id: string }) => row.id === ids.customerId,
    );
    assert.ok(JSON.stringify(customer).includes("CT-2026-501"));
  });

  it("agrees with the sale route, which refuses the lot", async () => {
    const sale = await app.inject({
      method: "POST",
      url: "/api/contracts",
      headers: { cookie },
      payload: {
        customerId: ids.customerId,
        lotId,
        kind: "contract",
        saleType: "cash",
        salePriceCents: 12_000_000,
        downPaymentCents: 0,
        signedOn: "2026-10-05",
      },
    });
    assert.equal(sale.statusCode, 409, sale.payload);
  });
});
