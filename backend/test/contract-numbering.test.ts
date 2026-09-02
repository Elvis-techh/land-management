import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";

import { contracts, lots } from "../src/db/schema.js";
import { OWNER_PASSWORD, buildTestApp, login } from "./helpers.js";

const lempiras = (amount: number) => Math.round(amount * 100);

/**
 * The contract number is `CT-YYYY-NNN`, and the year rolls past 999 in a busy
 * office. A text sort of the code puts "CT-2026-999" above "CT-2026-1000" — a
 * nine outranks a one, character by character — so the old logic handed out
 * 1000 a second time and every create after it collided on the unique index
 * for the rest of the year.
 */
describe("contract numbering past 999", async () => {
  const { app, db, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

  const freshLot = (code: string) => {
    const id = randomUUID();
    db.insert(lots)
      .values({ id, projectId: ids.projectId, code, areaM2: 300, basePriceCents: lempiras(100_000) })
      .run();
    return id;
  };

  /** Drop a contract straight in with a chosen code, to set up the boundary. */
  const seedContract = (code: string) => {
    db.insert(contracts)
      .values({
        id: randomUUID(),
        code,
        lotId: freshLot(`seed-${code}`),
        customerId: ids.customerId,
        kind: "contract",
        saleType: "cash",
        status: "active",
        salePriceCents: lempiras(100_000),
        downPaymentCents: 0,
        signedOn: "2026-01-01",
      })
      .run();
  };

  const create = (lotId: string) =>
    app.inject({
      method: "POST",
      url: "/api/contracts",
      headers: { cookie: ownerCookie },
      payload: {
        customerId: ids.customerId,
        lotId,
        kind: "contract",
        saleType: "cash",
        salePriceCents: lempiras(150_000),
        downPaymentCents: lempiras(150_000),
        signedOn: "2026-07-01",
      },
    });

  it("hands out 1000 after 999, not 1000 again", async () => {
    seedContract("CT-2026-999");

    const response = await create(freshLot("P-1000"));

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().contract.code, "CT-2026-1000");
  });

  it("keeps counting past 1000", async () => {
    const response = await create(freshLot("P-1001"));

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().contract.code, "CT-2026-1001");
  });

  it("still numbers a year that has no contracts yet from 001", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/contracts",
      headers: { cookie: ownerCookie },
      payload: {
        customerId: ids.customerId,
        lotId: freshLot("Q-01"),
        kind: "contract",
        saleType: "cash",
        salePriceCents: lempiras(150_000),
        downPaymentCents: lempiras(150_000),
        signedOn: "2027-02-01",
      },
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().contract.code, "CT-2027-001");
  });
});
