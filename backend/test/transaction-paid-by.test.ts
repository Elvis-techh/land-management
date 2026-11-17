import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";

import { contracts } from "../src/db/schema.js";
import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

const lempiras = (amount: number) => Math.round(amount * 100);

/**
 * «Pagado por» from «Corregir transacción».
 *
 * The receipt panel already had a button for it (`PATCH /receipts/:id/paid-by`).
 * These pin the second door: the correction form sends it along with the
 * other fields, it lands on the RECEIPT (so on every line of it), it is filed
 * in the Historial the same way, and it travels in the same transaction as the
 * correction so the two cannot half-happen.
 */
describe("«Pagado por» in a correction", async () => {
  const { app, db, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

  const secondContractId = randomUUID();

  db.insert(contracts)
    .values({
      id: secondContractId,
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

  type Row = {
    id: string;
    receiptId: string | null;
    amount: number;
    paidOn: string;
    method: string;
    type: string;
    receiptPaidBy: string | null;
  };

  const rows = async (): Promise<Row[]> =>
    (
      await app.inject({ method: "GET", url: "/api/transactions", headers: { cookie: ownerCookie } })
    ).json().transactions;

  /** A receipt of two lots — one piece of paper, two payment rows. */
  const issueTwoLots = async (paidBy?: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie: ownerCookie },
      payload: {
        customerId: ids.customerId,
        paidOn: "2026-03-15",
        method: "cash",
        ...(paidBy === undefined ? {} : { paidBy }),
        lines: [
          { contractId: ids.contractId, amountCents: lempiras(1_000), type: "installment" },
          { contractId: secondContractId, amountCents: lempiras(500), type: "installment" },
        ],
      },
    });

    assert.equal(response.statusCode, 201, response.body);

    const receipt = response.json().receipt as { id: string; code: string };
    const lines = (await rows()).filter((row) => row.receiptId === receipt.id);

    assert.equal(lines.length, 2);

    return { receipt, lines };
  };

  /** Today's figures, sent back unchanged, plus whatever the test is about. */
  const correct = (cookie: string, row: Row, extra: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: `/api/transactions/${row.id}`,
      headers: { cookie },
      payload: {
        amountCents: row.amount,
        paidOn: row.paidOn,
        method: row.method,
        type: row.type,
        reason: "Corrección de prueba sobre el recibo",
        ...extra,
      },
    });

  const payerOf = async (rowId: string) => (await rows()).find((row) => row.id === rowId)!.receiptPaidBy;

  const historyOf = async (entityId: string) =>
    (
      (await app.inject({ method: "GET", url: "/api/audit", headers: { cookie: ownerCookie } })).json()
        .events as Array<{ entityId: string; reason: string | null; before: any; after: any }>
    ).filter((event) => event.entityId === entityId);

  it("names the payer on the receipt, so on every line of it", async () => {
    const { lines } = await issueTwoLots();

    const response = await correct(ownerCookie, lines[0]!, { paidBy: "  Carlos Mejía  " });

    assert.equal(response.statusCode, 200, response.body);

    // The line that was open, and the one that was not.
    assert.equal(await payerOf(lines[0]!.id), "Carlos Mejía");
    assert.equal(await payerOf(lines[1]!.id), "Carlos Mejía");
  });

  it("puts the customer's name back when the box is emptied", async () => {
    const { lines } = await issueTwoLots("Pedro Equivocado");

    assert.equal(await payerOf(lines[0]!.id), "Pedro Equivocado");

    const response = await correct(ownerCookie, lines[1]!, { paidBy: "   " });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(await payerOf(lines[0]!.id), null);
    assert.equal(await payerOf(lines[1]!.id), null);
  });

  it("leaves the payer alone when the correction never mentions it", async () => {
    const { lines } = await issueTwoLots("Carlos Mejía");

    // Only the date moves. `paidBy` is absent, which is not the same as blank:
    // it must not put the customer's name back.
    const response = await correct(ownerCookie, lines[0]!, { paidOn: "2026-03-14" });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(await payerOf(lines[0]!.id), "Carlos Mejía");
    assert.equal(await payerOf(lines[1]!.id), "Carlos Mejía");
  });

  it("files the change in the Historial, on the receipt, with the reason", async () => {
    const { receipt, lines } = await issueTwoLots();

    const response = await correct(ownerCookie, lines[0]!, {
      paidBy: "Carlos Mejía",
      reason: "El recibo debe salir a nombre de quien entregó el dinero.",
    });

    assert.equal(response.statusCode, 200, response.body);

    const events = await historyOf(receipt.id);

    assert.equal(events.length, 1);
    assert.equal(events[0]!.reason, "El recibo debe salir a nombre de quien entregó el dinero.");
    // The same shape `PATCH /receipts/:id/paid-by` writes, so the Historial
    // names the receipt and reads «El cliente → Carlos Mejía».
    assert.deepEqual(events[0]!.before, { receiptCode: receipt.code, paidBy: null });
    assert.deepEqual(events[0]!.after, { receiptCode: receipt.code, paidBy: "Carlos Mejía" });
  });

  it("files nothing when the name sent is the one the receipt already has", async () => {
    const { receipt, lines } = await issueTwoLots("Carlos Mejía");

    // A form that always sends the field: same name, a new date.
    const response = await correct(ownerCookie, lines[0]!, {
      paidBy: "Carlos Mejía",
      paidOn: "2026-03-14",
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(await historyOf(receipt.id), []);
  });

  it("refuses money that was never on a receipt, which has no payer to name", async () => {
    const seeded = (await rows()).find((row) => row.receiptId === null);

    assert.ok(seeded, "the test database holds payments recorded before receipts");

    const response = await correct(ownerCookie, seeded!, { paidBy: "Carlos Mejía" });

    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, "no_receipt");
  });

  it("changes nothing at all when the correction itself is refused", async () => {
    const { receipt, lines } = await issueTwoLots();

    // More than the contract owes: refused until confirmed.
    const refused = await correct(ownerCookie, lines[0]!, {
      amountCents: lempiras(900_000),
      paidBy: "Carlos Mejía",
    });

    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(await payerOf(lines[0]!.id), null);
    assert.deepEqual(await historyOf(receipt.id), []);
  });

  it("is still only for those who may correct a payment", async () => {
    const { lines } = await issueTwoLots();

    const response = await correct(staffCookie, lines[0]!, { paidBy: "Carlos Mejía" });

    assert.equal(response.statusCode, 403, response.body);
    assert.equal(await payerOf(lines[0]!.id), null);
  });
});
