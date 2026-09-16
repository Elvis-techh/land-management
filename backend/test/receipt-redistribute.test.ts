import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { attachments, auditEvents, contracts, customers, payments } from "../src/db/schema.js";
import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

const lempiras = (amount: number) => Math.round(amount * 100);

type TestDb = Awaited<ReturnType<typeof buildTestApp>>["db"];

/**
 * The lot that was bought at the same time and registered weeks later.
 *
 * This is the whole scenario the route exists for: the customer paid one prima
 * for two lots, only one of them existed in the system that day, and the money
 * went entirely onto it.
 */
function addLateLot(db: TestDb, ids: { customerId: string; freeLotId: string }) {
  const contractId = randomUUID();

  db.insert(contracts)
    .values({
      id: contractId,
      code: "CT-TEST-002",
      lotId: ids.freeLotId,
      customerId: ids.customerId,
      kind: "contract",
      saleType: "financed",
      status: "active",
      salePriceCents: lempiras(80_000),
      downPaymentCents: lempiras(10_000),
      termMonths: 24,
      monthlyPaymentCents: lempiras(3_000),
      dueDay: 5,
      signedOn: "2026-01-10",
    })
    .run();

  return contractId;
}

/** Issue a receipt for one lot and hand back its id and the payment on it. */
async function issueSingleLotReceipt(
  app: Awaited<ReturnType<typeof buildTestApp>>["app"],
  cookie: string,
  contractId: string,
  customerId: string,
  amountCents: number,
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/receipts",
    headers: { cookie },
    payload: {
      customerId,
      paidOn: "2026-03-15",
      method: "cash",
      lines: [{ contractId, amountCents, type: "down_payment" }],
    },
  });

  assert.equal(response.statusCode, 201);

  return (response.json() as { receipt: Record<string, any> }).receipt;
}

describe("redistributing a receipt between lots", () => {
  it("moves part of a prima onto a lot registered later, without changing the receipt", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const issued = await issueSingleLotReceipt(
      app,
      cookie,
      ids.contractId,
      ids.customerId,
      lempiras(40_000),
    );

    // The second lot is created AFTER the money was taken, which is the point.
    const lateId = addLateLot(db, ids);

    const response = await app.inject({
      method: "POST",
      url: `/api/receipts/${issued.id}/redistribute`,
      headers: { cookie },
      payload: {
        reason: "La prima cubría dos lotes; el segundo se registró después.",
        lines: [
          { contractId: ids.contractId, amountCents: lempiras(20_000) },
          { contractId: lateId, amountCents: lempiras(20_000) },
        ],
      },
    });

    assert.equal(response.statusCode, 200);

    const { receipt } = response.json() as { receipt: Record<string, any> };

    // THE assertion. The customer is holding a piece of paper that says
    // L 40,000 and nothing this route does may disagree with it.
    assert.equal(receipt.totalPaid, lempiras(40_000));
    assert.equal(receipt.transactionCount, 2);
    assert.equal(
      receipt.lines.reduce((total: number, line: any) => total + line.amount, 0),
      lempiras(40_000),
    );

    // And the money actually landed on the second lot.
    const onLate = db.select().from(payments).where(eq(payments.contractId, lateId)).all();

    assert.equal(onLate.length, 1);
    assert.equal(onLate[0]!.amountCents, lempiras(20_000));
    assert.equal(onLate[0]!.receiptId, issued.id);
    // Inherited from the payment it was split off, not from the type default.
    assert.equal(onLate[0]!.type, "down_payment");

    await app.close();
  });

  it("gives the new row the original payment's date, not today's", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const issued = await issueSingleLotReceipt(
      app,
      cookie,
      ids.contractId,
      ids.customerId,
      lempiras(40_000),
    );

    const source = db.select().from(payments).where(eq(payments.receiptId, issued.id)).get()!;
    const lateId = addLateLot(db, ids);

    await app.inject({
      method: "POST",
      url: `/api/receipts/${issued.id}/redistribute`,
      headers: { cookie },
      payload: {
        reason: "Repartir la prima entre los dos lotes de la compra.",
        lines: [
          { contractId: ids.contractId, amountCents: lempiras(20_000) },
          { contractId: lateId, amountCents: lempiras(20_000) },
        ],
      },
    });

    const created = db.select().from(payments).where(eq(payments.contractId, lateId)).get()!;

    // Same money, same day. A row stamped today would sort months away from
    // its siblings and the receipt's own "saldo anterior" would drift.
    assert.equal(created.paidOn, "2026-03-15");
    assert.equal(created.paidOn, source.paidOn);
    assert.equal(created.createdAt, source.createdAt);

    await app.close();
  });

  it("re-derives both contracts' balances from the new distribution", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const issued = await issueSingleLotReceipt(
      app,
      cookie,
      ids.contractId,
      ids.customerId,
      lempiras(40_000),
    );
    const lateId = addLateLot(db, ids);

    await app.inject({
      method: "POST",
      url: `/api/receipts/${issued.id}/redistribute`,
      headers: { cookie },
      payload: {
        reason: "La prima cubría dos lotes; se reparte como se pagó.",
        lines: [
          { contractId: ids.contractId, amountCents: lempiras(25_000) },
          { contractId: lateId, amountCents: lempiras(15_000) },
        ],
      },
    });

    const detail = await app.inject({
      method: "GET",
      url: `/api/receipts/${issued.id}`,
      headers: { cookie },
    });

    const { receipt } = detail.json() as { receipt: Record<string, any> };
    const byContract = new Map<string, any>(
      receipt.lines.map((line: any) => [line.contractId, line]),
    );

    assert.equal(byContract.get(ids.contractId)!.amount, lempiras(25_000));
    assert.equal(byContract.get(lateId)!.amount, lempiras(15_000));
    assert.equal(receipt.totalPaid, lempiras(40_000));

    await app.close();
  });

  it("refuses a distribution that does not add up to the receipt", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const issued = await issueSingleLotReceipt(
      app,
      cookie,
      ids.contractId,
      ids.customerId,
      lempiras(40_000),
    );
    const lateId = addLateLot(db, ids);

    const response = await app.inject({
      method: "POST",
      url: `/api/receipts/${issued.id}/redistribute`,
      headers: { cookie },
      payload: {
        reason: "Un intento de repartir mal, que debe ser rechazado.",
        lines: [
          { contractId: ids.contractId, amountCents: lempiras(20_000) },
          { contractId: lateId, amountCents: lempiras(25_000) },
        ],
      },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "total_changed");

    // Nothing was written: the receipt still carries exactly one row.
    const rows = db.select().from(payments).where(eq(payments.receiptId, issued.id)).all();

    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.amountCents, lempiras(40_000));

    await app.close();
  });

  it("never lets a receipt's face total drift, whatever the split", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const issued = await issueSingleLotReceipt(
      app,
      cookie,
      ids.contractId,
      ids.customerId,
      lempiras(40_000),
    );
    const lateId = addLateLot(db, ids);

    // Redistribute repeatedly. The reverse-and-reinsert implementation this
    // route deliberately avoids would double the total on the FIRST pass, and
    // keep doubling here.
    for (const [first, second] of [
      [30_000, 10_000],
      [10_000, 30_000],
      [20_000, 20_000],
      [39_900, 100],
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/receipts/${issued.id}/redistribute`,
        headers: { cookie },
        payload: {
          reason: "Ajustando el reparto de la prima entre los dos lotes.",
          lines: [
            { contractId: ids.contractId, amountCents: lempiras(first!) },
            { contractId: lateId, amountCents: lempiras(second!) },
          ],
        },
      });

      assert.equal(response.statusCode, 200);

      const { receipt } = response.json() as { receipt: Record<string, any> };

      assert.equal(receipt.totalPaid, lempiras(40_000));
      assert.equal(receipt.transactionCount, 2);
    }

    const rows = db.select().from(payments).where(eq(payments.receiptId, issued.id)).all();

    assert.equal(rows.length, 2);
    assert.equal(
      rows.reduce((total, row) => total + row.amountCents, 0),
      lempiras(40_000),
    );

    await app.close();
  });

  it("drops a lot that ends up with nothing instead of printing a zero line", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const issued = await issueSingleLotReceipt(
      app,
      cookie,
      ids.contractId,
      ids.customerId,
      lempiras(40_000),
    );
    const lateId = addLateLot(db, ids);

    // The money was filed against the wrong lot entirely.
    const response = await app.inject({
      method: "POST",
      url: `/api/receipts/${issued.id}/redistribute`,
      headers: { cookie },
      payload: {
        reason: "La prima era del otro lote; se movió completa.",
        lines: [{ contractId: lateId, amountCents: lempiras(40_000) }],
      },
    });

    assert.equal(response.statusCode, 200);

    const { receipt } = response.json() as { receipt: Record<string, any> };

    assert.equal(receipt.totalPaid, lempiras(40_000));
    assert.equal(receipt.transactionCount, 1);
    assert.equal(receipt.lines.length, 1);
    assert.equal(receipt.lines[0].contractId, lateId);

    const rows = db.select().from(payments).where(eq(payments.receiptId, issued.id)).all();

    assert.equal(rows.length, 1);

    await app.close();
  });

  it("refuses to drop a line that is carrying the customer's proof", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const issued = await issueSingleLotReceipt(
      app,
      cookie,
      ids.contractId,
      ids.customerId,
      lempiras(40_000),
    );
    const lateId = addLateLot(db, ids);
    const source = db.select().from(payments).where(eq(payments.receiptId, issued.id)).get()!;

    db.insert(attachments)
      .values({
        id: randomUUID(),
        receiptId: issued.id,
        paymentId: source.id,
        storageKey: "stored/deposito.pdf",
        fileName: "deposito.pdf",
        contentType: "application/pdf",
        byteSize: 1024,
        uploadedBy: ids.ownerId,
      })
      .run();

    const response = await app.inject({
      method: "POST",
      url: `/api/receipts/${issued.id}/redistribute`,
      headers: { cookie },
      payload: {
        reason: "Mover todo al otro lote, con el comprobante pegado a la línea.",
        lines: [{ contractId: lateId, amountCents: lempiras(40_000) }],
      },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "proof_attached");

    // The row — and the file pointing at it — are both still there.
    assert.equal(db.select().from(payments).where(eq(payments.id, source.id)).all().length, 1);

    await app.close();
  });

  it("refuses to file a customer's money against somebody else's lot", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const issued = await issueSingleLotReceipt(
      app,
      cookie,
      ids.contractId,
      ids.customerId,
      lempiras(40_000),
    );

    // A real second customer, holding a real contract. The point of the check
    // is that this lot is somebody else's, not that its ids are bogus.
    const strangerId = randomUUID();
    const strangerContractId = randomUUID();

    db.insert(customers)
      .values({
        id: strangerId,
        fullName: "Otro Cliente",
        identification: "0801-1990-00002",
        phone: "+50499990001",
        email: null,
        address: null,
        customerSince: 2025,
      })
      .run();

    db.insert(contracts)
      .values({
        id: strangerContractId,
        code: "CT-TEST-999",
        lotId: ids.freeLotId,
        customerId: strangerId,
        kind: "contract",
        status: "active",
        salePriceCents: lempiras(80_000),
      })
      .run();

    const response = await app.inject({
      method: "POST",
      url: `/api/receipts/${issued.id}/redistribute`,
      headers: { cookie },
      payload: {
        reason: "Intento de mover dinero al lote de otra persona.",
        lines: [
          { contractId: ids.contractId, amountCents: lempiras(20_000) },
          { contractId: strangerContractId, amountCents: lempiras(20_000) },
        ],
      },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "contract_not_customers");

    await app.close();
  });

  it("refuses to overpay a lot unless the overpayment is confirmed", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const issued = await issueSingleLotReceipt(
      app,
      cookie,
      ids.contractId,
      ids.customerId,
      lempiras(40_000),
    );
    // Owes L 80,000, so L 90,000 of this receipt cannot land on it.
    const lateId = addLateLot(db, ids);

    const payload = {
      reason: "Todo el dinero a un lote que no debe tanto.",
      lines: [{ contractId: lateId, amountCents: lempiras(40_000) }],
    };

    // L 40,000 fits inside L 80,000, so raise the stakes: issue a bigger one.
    const bigger = await issueSingleLotReceipt(
      app,
      cookie,
      ids.contractId,
      ids.customerId,
      lempiras(90_000),
    );

    const refused = await app.inject({
      method: "POST",
      url: `/api/receipts/${bigger.id}/redistribute`,
      headers: { cookie },
      payload: {
        reason: "Todo el dinero a un lote que no debe tanto.",
        lines: [{ contractId: lateId, amountCents: lempiras(90_000) }],
      },
    });

    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().error, "overpayment");

    const allowed = await app.inject({
      method: "POST",
      url: `/api/receipts/${bigger.id}/redistribute`,
      headers: { cookie },
      payload: {
        reason: "Todo el dinero a un lote que no debe tanto.",
        allowOverpayment: true,
        lines: [{ contractId: lateId, amountCents: lempiras(90_000) }],
      },
    });

    assert.equal(allowed.statusCode, 200);
    assert.equal((allowed.json() as any).receipt.totalPaid, lempiras(90_000));

    // Referenced so the unused-variable rule and the reader agree this was the
    // smaller receipt that legitimately fits.
    assert.equal(payload.lines[0]!.amountCents, lempiras(40_000));
    assert.equal(issued.totalPaid, lempiras(40_000));

    await app.close();
  });

  it("refuses to redistribute a voided receipt", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const issued = await issueSingleLotReceipt(
      app,
      cookie,
      ids.contractId,
      ids.customerId,
      lempiras(40_000),
    );
    const lateId = addLateLot(db, ids);

    await app.inject({
      method: "POST",
      url: `/api/receipts/${issued.id}/void`,
      headers: { cookie },
      payload: { reason: "Anulado porque el cheque no tenía fondos." },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/receipts/${issued.id}/redistribute`,
      headers: { cookie },
      payload: {
        reason: "Repartir un recibo que ya está anulado.",
        lines: [
          { contractId: ids.contractId, amountCents: lempiras(20_000) },
          { contractId: lateId, amountCents: lempiras(20_000) },
        ],
      },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "already_voided");

    await app.close();
  });

  it("demands a written reason, like every other rewrite of a posted figure", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const issued = await issueSingleLotReceipt(
      app,
      cookie,
      ids.contractId,
      ids.customerId,
      lempiras(40_000),
    );
    const lateId = addLateLot(db, ids);

    const response = await app.inject({
      method: "POST",
      url: `/api/receipts/${issued.id}/redistribute`,
      headers: { cookie },
      payload: {
        reason: "corto",
        lines: [
          { contractId: ids.contractId, amountCents: lempiras(20_000) },
          { contractId: lateId, amountCents: lempiras(20_000) },
        ],
      },
    });

    assert.equal(response.statusCode, 400);

    await app.close();
  });

  it("writes the before and after of the whole split to the audit history", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const issued = await issueSingleLotReceipt(
      app,
      cookie,
      ids.contractId,
      ids.customerId,
      lempiras(40_000),
    );
    const lateId = addLateLot(db, ids);
    const reason = "La prima cubría dos lotes; el segundo se registró después.";

    await app.inject({
      method: "POST",
      url: `/api/receipts/${issued.id}/redistribute`,
      headers: { cookie },
      payload: {
        reason,
        lines: [
          { contractId: ids.contractId, amountCents: lempiras(20_000) },
          { contractId: lateId, amountCents: lempiras(20_000) },
        ],
      },
    });

    const receiptEntry = db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, issued.id))
      .all()
      .find((entry) => entry.action === "update")!;

    assert.ok(receiptEntry, "the receipt-level entry must exist");
    assert.equal(receiptEntry.reason, reason);

    const before = JSON.parse(receiptEntry.beforeJson!);
    const after = JSON.parse(receiptEntry.afterJson!);

    // The previous distribution is still answerable for, which is what makes
    // editing posted figures in place acceptable at all.
    assert.equal(before.totalCents, lempiras(40_000));
    assert.equal(before.lines.length, 1);
    assert.equal(before.lines[0].amountCents, lempiras(40_000));
    assert.equal(after.totalCents, lempiras(40_000));
    assert.equal(after.lines.length, 2);

    await app.close();
  });

  it("is closed to staff, who may record payments but not rewrite them", async () => {
    const { app, db, ids } = await buildTestApp();
    const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
    const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

    const issued = await issueSingleLotReceipt(
      app,
      ownerCookie,
      ids.contractId,
      ids.customerId,
      lempiras(40_000),
    );
    const lateId = addLateLot(db, ids);

    const response = await app.inject({
      method: "POST",
      url: `/api/receipts/${issued.id}/redistribute`,
      headers: { cookie: staffCookie },
      payload: {
        reason: "Repartir la prima entre los dos lotes de la compra.",
        lines: [
          { contractId: ids.contractId, amountCents: lempiras(20_000) },
          { contractId: lateId, amountCents: lempiras(20_000) },
        ],
      },
    });

    assert.equal(response.statusCode, 403);

    await app.close();
  });
});
