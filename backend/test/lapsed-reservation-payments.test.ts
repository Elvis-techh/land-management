import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { contracts, lots } from "../src/db/schema.js";
import { OWNER_PASSWORD, buildTestApp, login } from "./helpers.js";

const lempiras = (amount: number) => Math.round(amount * 100);

/**
 * Code review P3-2. A reservation past its date still reads status 'active'
 * (nothing sweeps it), so the payment routes, which only checked the status,
 * took money on it, even after its lot was sold to another customer. That
 * customer then carried a balance on a lot that belongs to someone else.
 */
describe("payments on a lapsed reservation (P3-2)", async () => {
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

  const addContract = (
    lotId: string,
    code: string,
    kind: "reservation" | "contract",
    expiresOn: string | null,
  ) => {
    const id = randomUUID();
    db.insert(contracts)
      .values({
        id,
        code,
        lotId,
        customerId: ids.customerId,
        kind,
        saleType: "financed",
        status: "active",
        salePriceCents: lempiras(100_000),
        downPaymentCents: lempiras(10_000),
        termMonths: 12,
        monthlyPaymentCents: lempiras(7_500),
        dueDay: 1,
        signedOn: "2020-01-01",
        expiresOn,
      })
      .run();
    return id;
  };

  const pay = (lines: { contractId: string; amountCents: number }[]) =>
    app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie },
      payload: {
        customerId: ids.customerId,
        paidOn: "2026-03-15",
        method: "cash",
        lines: lines.map((line) => ({ ...line, type: "installment" })),
      },
    });

  const redistribute = (receiptId: string, lines: { contractId: string; amountCents: number }[]) =>
    app.inject({
      method: "POST",
      url: `/api/receipts/${receiptId}/redistribute`,
      headers: { cookie },
      payload: { reason: "Corregir a qué lote fue el pago.", lines },
    });

  const lapsedId = addContract(addLot("P32-A"), "CT-2020-301", "reservation", "2020-02-01");
  const liveId = addContract(addLot("P32-B"), "CT-2020-302", "contract", null);

  it("refuses a payment on a reservation past its date", async () => {
    const response = await pay([{ contractId: lapsedId, amountCents: lempiras(1_000) }]);

    assert.equal(response.statusCode, 409, response.payload);
    assert.equal(response.json().error, "contract_closed");
    assert.match(response.json().message, /venció/);
  });

  it("refuses it after the lot was sold to someone else, too", async () => {
    const lotId = addLot("P32-C");
    const reservationId = addContract(lotId, "CT-2020-303", "reservation", "2020-02-01");

    const sale = await app.inject({
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
    assert.equal(sale.statusCode, 201, sale.payload);

    const response = await pay([{ contractId: reservationId, amountCents: lempiras(1_000) }]);
    assert.equal(response.statusCode, 409, response.payload);
  });

  it("still takes a payment on a reservation that has not lapsed", async () => {
    const reservationId = addContract(addLot("P32-D"), "CT-2020-304", "reservation", future);

    const response = await pay([{ contractId: reservationId, amountCents: lempiras(1_000) }]);
    assert.equal(response.statusCode, 201, response.payload);
  });

  describe("redistributing a receipt", async () => {
    // Paid while the reservation was live; it lapses afterwards.
    const reservationId = addContract(addLot("P32-E"), "CT-2020-305", "reservation", future);

    const issued = await pay([
      { contractId: reservationId, amountCents: lempiras(1_000) },
      { contractId: liveId, amountCents: lempiras(1_000) },
    ]);
    assert.equal(issued.statusCode, 201, issued.payload);
    const receiptId = issued.json().receipt.id as string;

    db.update(contracts)
      .set({ expiresOn: "2020-02-01" })
      .where(eq(contracts.id, reservationId))
      .run();

    it("refuses to move more money onto the lapsed reservation", async () => {
      const response = await redistribute(receiptId, [
        { contractId: reservationId, amountCents: lempiras(1_500) },
        { contractId: liveId, amountCents: lempiras(500) },
      ]);

      assert.equal(response.statusCode, 409, response.payload);
      assert.equal(response.json().error, "contract_closed");
    });

    it("lets the money be moved off it onto a live contract", async () => {
      const response = await redistribute(receiptId, [
        { contractId: liveId, amountCents: lempiras(2_000) },
      ]);

      assert.equal(response.statusCode, 200, response.payload);
    });
  });
});
