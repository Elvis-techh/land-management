import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { auditEvents, contracts, lots } from "../src/db/schema.js";
import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

const lempiras = (amount: number) => Math.round(amount * 100);

describe("a contract that is paid in full", async () => {
  const { app, db, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url, headers: { cookie: ownerCookie }, payload });
  const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie: ownerCookie } });

  const freshLot = (code: string) => {
    const id = randomUUID();
    db.insert(lots)
      .values({ id, projectId: ids.projectId, code, areaM2: 300, basePriceCents: lempiras(50_000) })
      .run();
    return id;
  };

  // A cash sale of L 50,000, nothing paid yet.
  const lotId = freshLot("PO-01");
  const contractId = (
    await post("/api/contracts", {
      customerId: ids.customerId,
      lotId,
      kind: "contract",
      saleType: "cash",
      salePriceCents: lempiras(50_000),
      downPaymentCents: 0,
      signedOn: "2026-04-01",
    })
  ).json().contract.id;

  const statusOf = () =>
    db.select({ status: contracts.status }).from(contracts).where(eq(contracts.id, contractId)).get()
      ?.status;

  const contractView = async () =>
    (await get("/api/contracts")).json().contracts.find((c: { id: string }) => c.id === contractId);

  it("starts active", () => {
    assert.equal(statusOf(), "active");
  });

  let receiptId = "";

  it("settles to paid_off when the final payment lands", async () => {
    const receipt = await post("/api/receipts", {
      customerId: ids.customerId,
      paidOn: "2026-04-01",
      method: "cash",
      lines: [{ contractId, amountCents: lempiras(50_000), type: "full_payment" }],
    });

    assert.equal(receipt.statusCode, 201);
    receiptId = receipt.json().receipt.id;

    assert.equal(statusOf(), "paid_off");

    const view = await contractView();
    assert.equal(view.status, "paid_off");
    assert.equal(view.balance, 0);

    // The transition is in the history.
    const settle = db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, contractId))
      .all()
      .find((row) => row.action === "settle");
    assert.ok(settle, "the settle transition must be audited");
  });

  it("still holds its lot — the lot reads as sold, not available", async () => {
    const lot = (await get("/api/lots")).json().lots.find((l: { code: string }) => l.code === "PO-01");
    assert.ok(lot.holding, "a paid-off lot is still held");
    assert.equal(lot.holding.contractCode, (await contractView()).code);
  });

  it("cannot be sold to someone else", async () => {
    const response = await post("/api/contracts", {
      customerId: ids.customerId,
      lotId,
      kind: "contract",
      saleType: "cash",
      salePriceCents: lempiras(50_000),
      downPaymentCents: lempiras(50_000),
      signedOn: "2026-05-01",
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "lot_taken");
  });

  it("drops out of the customer's live holdings", async () => {
    const customer = (await get("/api/customers"))
      .json()
      .customers.find((c: { id: string }) => c.id === ids.customerId);

    assert.equal(
      customer.contracts.some((c: { contractId: string }) => c.contractId === contractId),
      false,
      "a paid-off contract is history, not a live holding",
    );
  });

  it("reopens to active when the receipt is voided", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/receipts/${receiptId}/void`,
      headers: { cookie: ownerCookie },
      payload: { reason: "Se anula el recibo para corregir el monto." },
    });
    assert.equal(response.statusCode, 200);

    assert.equal(statusOf(), "active");

    const reopen = db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, contractId))
      .all()
      .find((row) => row.action === "reopen");
    assert.ok(reopen, "the reopen transition must be audited");
  });
});

describe("declaring a contract incumplido", async () => {
  const { app, db, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

  const defaultContract = (cookie: string, id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/api/contracts/${id}/default`,
      headers: { cookie },
      payload,
    });

  it("is owner-only and cannot be granted to staff", async () => {
    // Try to grant it — the permissions endpoint refuses loudly.
    const grant = await app.inject({
      method: "PUT",
      url: "/api/permissions",
      headers: { cookie: ownerCookie },
      payload: {
        capabilities: ["contract:create", "payment:record", "contract:default"],
      },
    });
    assert.equal(grant.statusCode, 400);
    assert.equal(grant.json().error, "locked_capability");

    // And staff simply cannot call it.
    const denied = await defaultContract(staffCookie, ids.contractId, {
      reason: "El cliente dijo que ya no puede seguir pagando el contrato.",
      settlement: "none",
    });
    assert.equal(denied.statusCode, 403);
  });

  it("marks the contract defaulted, keeps the money as income, frees the lot", async () => {
    const before = (await app.inject({ method: "GET", url: "/api/lots", headers: { cookie: ownerCookie } }))
      .json()
      .lots.find((l: { id: string }) => l.id === ids.heldLotId);
    assert.ok(before.holding, "the lot starts held");

    const response = await defaultContract(ownerCookie, ids.contractId, {
      reason: "El cliente perdió el empleo y no podrá continuar con los pagos.",
      settlement: "none",
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().settlement, "none");

    const row = db.select().from(contracts).where(eq(contracts.id, ids.contractId)).get();
    assert.equal(row?.status, "defaulted");
    assert.equal(row?.closedSettlement, "none");
    assert.match(row!.closedReason!, /empleo/);

    const after = (await app.inject({ method: "GET", url: "/api/lots", headers: { cookie: ownerCookie } }))
      .json()
      .lots.find((l: { id: string }) => l.id === ids.heldLotId);
    assert.equal(after.holding, null, "a defaulted contract releases its lot");

    const audit = db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, ids.contractId))
      .all()
      .find((r) => r.action === "default");
    assert.ok(audit, "the default is filed under its own action");
    assert.equal(JSON.parse(audit!.beforeJson!).paidToDateCents, lempiras(15_000));
  });

  it("refuses to default an already-closed contract", async () => {
    const again = await defaultContract(ownerCookie, ids.contractId, {
      reason: "Intento de declarar incumplido un contrato ya cerrado.",
      settlement: "none",
    });
    assert.equal(again.statusCode, 409);
  });
});
