import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { contracts, lots, payments } from "../src/db/schema.js";
import { OWNER_PASSWORD, buildTestApp, login } from "./helpers.js";

const lempiras = (amount: number) => Math.round(amount * 100);

/**
 * Code review P3-4. Recording and redistributing money both refuse a closed
 * contract (cancelled, defaulted, replaced by an adenda), but correcting a
 * payment (PATCH /transactions/:id) did not: it could change the amount or the
 * date of money whose fate was settled when the contract closed. Reference,
 * method, type and notes must stay correctable.
 */
describe("correcting a payment on a closed contract (P3-4)", async () => {
  const { app, db, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

  const addContract = (code: string) => {
    const lotId = randomUUID();
    db.insert(lots)
      .values({ id: lotId, projectId: ids.projectId, code, areaM2: 300, basePriceCents: lempiras(100_000) })
      .run();

    const id = randomUUID();
    db.insert(contracts)
      .values({
        id,
        code: `CT-${code}`,
        lotId,
        customerId: ids.customerId,
        kind: "contract",
        saleType: "financed",
        status: "active",
        salePriceCents: lempiras(100_000),
        downPaymentCents: lempiras(10_000),
        termMonths: 12,
        monthlyPaymentCents: lempiras(7_500),
        dueDay: 1,
        signedOn: "2026-01-01",
      })
      .run();
    return id;
  };

  const liveId = addContract("P34-A");
  const closedId = addContract("P34-B");

  // One receipt paying both lots, recorded while both were open.
  const issued = await app.inject({
    method: "POST",
    url: "/api/receipts",
    headers: { cookie },
    payload: {
      customerId: ids.customerId,
      paidOn: "2026-03-15",
      method: "cash",
      lines: [
        { contractId: liveId, amountCents: lempiras(1_000), type: "installment" },
        { contractId: closedId, amountCents: lempiras(1_000), type: "installment" },
      ],
    },
  });
  assert.equal(issued.statusCode, 201, issued.payload);

  const lineOf = (contractId: string) =>
    db.select().from(payments).where(eq(payments.contractId, contractId)).get()!;
  const liveLine = lineOf(liveId);
  const closedLine = lineOf(closedId);

  db.update(contracts).set({ status: "cancelled" }).where(eq(contracts.id, closedId)).run();

  const correct = (paymentId: string, changes: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: `/api/transactions/${paymentId}`,
      headers: { cookie },
      payload: {
        amountCents: lempiras(1_000),
        paidOn: "2026-03-15",
        method: "cash",
        type: "installment",
        reason: "Corrección hecha con el recibo físico a la vista.",
        ...changes,
      },
    });

  it("refuses to change the amount", async () => {
    const response = await correct(closedLine.id, { amountCents: lempiras(2_000) });

    assert.equal(response.statusCode, 409, response.payload);
    assert.equal(response.json().error, "contract_closed");
    assert.equal(lineOf(closedId).amountCents, lempiras(1_000));
  });

  it("refuses to change the date", async () => {
    const response = await correct(closedLine.id, { paidOn: "2026-04-01" });

    assert.equal(response.statusCode, 409, response.payload);
    assert.equal(lineOf(closedId).paidOn, "2026-03-15");
  });

  it("refuses to move its date through a sibling line of the same receipt", async () => {
    const response = await correct(liveLine.id, {
      paidOn: "2026-04-01",
      applyToPaymentIds: [closedLine.id],
    });

    assert.equal(response.statusCode, 409, response.payload);
    assert.equal(lineOf(closedId).paidOn, "2026-03-15");
    assert.equal(lineOf(liveId).paidOn, "2026-03-15", "nothing half-applied");
  });

  it("still lets the reference and method be corrected", async () => {
    const response = await correct(closedLine.id, {
      method: "transfer",
      reference: "BAC-123456",
    });

    assert.equal(response.statusCode, 200, response.payload);
    assert.equal(lineOf(closedId).reference, "BAC-123456");
  });

  it("still lets a live contract's line change amount and date", async () => {
    const response = await correct(liveLine.id, {
      amountCents: lempiras(1_500),
      paidOn: "2026-03-16",
    });

    assert.equal(response.statusCode, 200, response.payload);
  });
});
