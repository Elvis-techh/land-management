import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { auditEvents, contracts, payments } from "../src/db/schema.js";
import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

const lempiras = (amount: number) => Math.round(amount * 100);

type TestDb = Awaited<ReturnType<typeof buildTestApp>>["db"];

/** A second and third contract for the same customer, for the split tests. */
function addContracts(db: TestDb, ids: { customerId: string; freeLotId: string }) {
  const second = randomUUID();
  const third = randomUUID();

  db.insert(contracts)
    .values([
      {
        id: second,
        code: "CT-TEST-002",
        lotId: ids.freeLotId,
        customerId: ids.customerId,
        kind: "contract",
        status: "active",
        salePriceCents: lempiras(80_000),
      },
      {
        id: third,
        code: "CT-TEST-003",
        lotId: ids.freeLotId,
        customerId: ids.customerId,
        kind: "contract",
        status: "active",
        salePriceCents: lempiras(60_000),
      },
    ])
    .run();

  return { second, third };
}

describe("the transactions list", () => {
  it("carries the customer, the lot and the receipt for every payment", async () => {
    const { app } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const response = await app.inject({
      method: "GET",
      url: "/api/transactions",
      headers: { cookie },
    });

    assert.equal(response.statusCode, 200);

    const rows = response.json().transactions as any[];
    assert.equal(rows.length, 2);

    for (const row of rows) {
      assert.ok(row.customerName);
      assert.ok(row.lotCode);
      assert.ok(row.contractCode);
      assert.ok(row.recordedByName);
      // Seeded payments predate receipts, so this is null rather than absent —
      // which is what lets the screen show them as awaiting a document.
      assert.equal(row.receiptId, null);
    }

    // Newest first, so the by-date view needs no second sort to look right.
    assert.deepEqual(
      rows.map((row) => row.paidOn),
      ["2026-02-15", "2026-01-15"],
    );

    await app.close();
  });

  it("includes a payment made through a receipt, linked to it", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const issued = await app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie },
      payload: {
        customerId: ids.customerId,
        paidOn: "2026-03-15",
        method: "cash",
        lines: [{ contractId: ids.contractId, amountCents: lempiras(6_700), type: "installment" }],
      },
    });

    const rows = (
      await app.inject({ method: "GET", url: "/api/transactions", headers: { cookie } })
    ).json().transactions as any[];

    const linked = rows.find((row) => row.receiptId !== null);

    assert.equal(rows.length, 3);
    assert.equal(linked.receiptCode, issued.json().receipt.code);
    assert.equal(linked.amount, lempiras(6_700));

    await app.close();
  });

  it("refuses an anonymous request", async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/api/transactions" });

    assert.equal(response.statusCode, 401);

    await app.close();
  });
});

describe("dividing one amount across a customer's lots", () => {
  it("splits into round numbers that sum to exactly what was handed over", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
    addContracts(db, ids);

    const response = await app.inject({
      method: "GET",
      url: `/api/customers/${ids.customerId}/split?amountCents=${lempiras(25_000)}`,
      headers: { cookie },
    });

    assert.equal(response.statusCode, 200);

    const { lines, unallocatedCents } = response.json() as {
      lines: Array<{ amountCents: number; lotCode: string }>;
      unallocatedCents: number;
    };

    const total = lines.reduce((sum, line) => sum + line.amountCents, 0);

    assert.equal(total + unallocatedCents, lempiras(25_000));
    assert.equal(unallocatedCents, 0);
    assert.equal(lines.length, 3);

    // Whole hundreds, the way it is written by hand at a window.
    for (const line of lines) {
      assert.equal(line.amountCents % 10_000, 0);
    }

    await app.close();
  });

  it("gives the odd remainder to the lot that owes the most", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
    addContracts(db, ids);

    const { lines } = (
      await app.inject({
        method: "GET",
        url: `/api/customers/${ids.customerId}/split?amountCents=${lempiras(25_000)}`,
        headers: { cookie },
      })
    ).json() as { lines: Array<{ contractId: string; amountCents: number; balanceBefore: number }> };

    const largest = [...lines].sort((a, b) => b.balanceBefore - a.balanceBefore)[0]!;
    const most = Math.max(...lines.map((line) => line.amountCents));

    assert.equal(largest.amountCents, most);

    await app.close();
  });

  it("never puts more on a lot than it still owes, and says what is left over", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    // The single contract owes L 170,000. Handing over L 200,000 leaves 30,000
    // that cannot be placed — returned rather than absorbed.
    const { lines, unallocatedCents } = (
      await app.inject({
        method: "GET",
        url: `/api/customers/${ids.customerId}/split?amountCents=${lempiras(200_000)}`,
        headers: { cookie },
      })
    ).json() as { lines: Array<{ amountCents: number }>; unallocatedCents: number };

    assert.equal(lines[0]!.amountCents, lempiras(170_000));
    assert.equal(unallocatedCents, lempiras(30_000));

    await app.close();
  });

  it("refuses a missing or nonsensical amount", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    for (const query of ["", "?amountCents=0", "?amountCents=-500", "?amountCents=abc"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/customers/${ids.customerId}/split${query}`,
        headers: { cookie },
      });

      assert.equal(response.statusCode, 400);
    }

    await app.close();
  });
});

describe("correcting a transaction", () => {
  const editPayload = {
    amountCents: lempiras(10_000),
    paidOn: "2026-01-15",
    method: "cash" as const,
    type: "down_payment" as const,
    reason: "El cliente entregó L 10,000, no L 5,000. Corregido con el recibo físico a la vista.",
  };

  /** The seeded down payment: L 10,000 on 15 January. */
  function firstPayment(db: TestDb, contractId: string) {
    return db
      .select()
      .from(payments)
      .where(eq(payments.contractId, contractId))
      .all()
      .sort((a, b) => a.paidOn.localeCompare(b.paidOn))[0]!;
  }

  it("changes the amount and re-derives every balance after it", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const target = firstPayment(db, ids.contractId);

    const before = (
      await app.inject({ method: "GET", url: "/api/contracts", headers: { cookie } })
    ).json().contracts.find((c: any) => c.id === ids.contractId);

    assert.equal(before.paidToDate, lempiras(15_000));

    const response = await app.inject({
      method: "PATCH",
      url: `/api/transactions/${target.id}`,
      headers: { cookie },
      payload: { ...editPayload, amountCents: lempiras(20_000) },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().transaction.amount, lempiras(20_000));

    const after = (
      await app.inject({ method: "GET", url: "/api/contracts", headers: { cookie } })
    ).json().contracts.find((c: any) => c.id === ids.contractId);

    // The correction flowed straight through: nothing was unlocked or re-frozen.
    assert.equal(after.paidToDate, lempiras(25_000));
    assert.equal(after.balance, before.balance - lempiras(10_000));

    await app.close();
  });

  it("moves the receipts that follow it", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const issued = await app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie },
      payload: {
        customerId: ids.customerId,
        paidOn: "2026-05-15",
        method: "cash",
        lines: [{ contractId: ids.contractId, amountCents: lempiras(6_700), type: "installment" }],
      },
    });

    const receiptId = issued.json().receipt.id;
    assert.equal(issued.json().receipt.previousBalance, lempiras(170_000));

    await app.inject({
      method: "PATCH",
      url: `/api/transactions/${firstPayment(db, ids.contractId).id}`,
      headers: { cookie },
      payload: { ...editPayload, amountCents: lempiras(20_000) },
    });

    const reread = await app.inject({
      method: "GET",
      url: `/api/receipts/${receiptId}`,
      headers: { cookie },
    });

    assert.equal(reread.json().receipt.previousBalance, lempiras(160_000));
    assert.equal(
      reread.json().receipt.previousBalance - reread.json().receipt.totalPaid,
      reread.json().receipt.newBalance,
    );

    await app.close();
  });

  it("moves a transaction to a different date and re-orders the ledger", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const target = firstPayment(db, ids.contractId);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/transactions/${target.id}`,
      headers: { cookie },
      payload: { ...editPayload, amountCents: target.amountCents, paidOn: "2026-06-01" },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().transaction.paidOn, "2026-06-01");

    // It is now the LAST transaction, so the list leads with it.
    const rows = (
      await app.inject({ method: "GET", url: "/api/transactions", headers: { cookie } })
    ).json().transactions as any[];

    assert.equal(rows[0]!.id, target.id);

    await app.close();
  });

  it("insists on a reason of real length", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/transactions/${firstPayment(db, ids.contractId).id}`,
      headers: { cookie },
      payload: { ...editPayload, reason: "ajuste" },
    });

    assert.equal(response.statusCode, 400);

    await app.close();
  });

  it("writes the old and the new figure into the history", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const target = firstPayment(db, ids.contractId);

    await app.inject({
      method: "PATCH",
      url: `/api/transactions/${target.id}`,
      headers: { cookie },
      payload: { ...editPayload, amountCents: lempiras(20_000) },
    });

    const events = (
      await app.inject({ method: "GET", url: "/api/audit", headers: { cookie } })
    ).json().events.filter((event: any) => event.entityId === target.id);

    assert.equal(events.length, 1);
    assert.equal(events[0].action, "update");
    assert.equal(events[0].reason, editPayload.reason);

    // The previous amount survives ONLY here, which is the whole justification
    // for editing in place rather than reversing.
    assert.equal(events[0].before.amountCents, lempiras(10_000));
    assert.equal(events[0].after.amountCents, lempiras(20_000));

    await app.close();
  });

  it("refuses an amount that would overpay, until it is confirmed", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const target = firstPayment(db, ids.contractId);

    const refused = await app.inject({
      method: "PATCH",
      url: `/api/transactions/${target.id}`,
      headers: { cookie },
      payload: { ...editPayload, amountCents: lempiras(900_000) },
    });

    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().error, "overpayment");
    // The room WITHOUT this payment: 185,000 − the other 5,000 payment.
    assert.equal(refused.json().balanceCents, lempiras(180_000));

    const allowed = await app.inject({
      method: "PATCH",
      url: `/api/transactions/${target.id}`,
      headers: { cookie },
      payload: { ...editPayload, amountCents: lempiras(900_000), allowOverpayment: true },
    });

    assert.equal(allowed.statusCode, 200);

    await app.close();
  });

  it("allows an edit that leaves the amount within what is owed", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    // Raising the prima to exactly the room available must NOT read as an
    // overpayment — the check has to exclude the payment being edited.
    const response = await app.inject({
      method: "PATCH",
      url: `/api/transactions/${firstPayment(db, ids.contractId).id}`,
      headers: { cookie },
      payload: { ...editPayload, amountCents: lempiras(180_000) },
    });

    assert.equal(response.statusCode, 200);

    await app.close();
  });

  it("refuses to edit a reversed transaction", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const issued = await app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie },
      payload: {
        customerId: ids.customerId,
        paidOn: "2026-03-15",
        method: "cash",
        lines: [{ contractId: ids.contractId, amountCents: lempiras(1_000), type: "installment" }],
      },
    });

    await app.inject({
      method: "POST",
      url: `/api/receipts/${issued.json().receipt.id}/void`,
      headers: { cookie },
      payload: { reason: "Depósito rechazado por el banco emisor." },
    });

    const paymentId = issued.json().receipt.lines[0].paymentId;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/transactions/${paymentId}`,
      headers: { cookie },
      payload: editPayload,
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "already_reversed");

    await app.close();
  });

  it("keeps the dollar figure in step when a foreign-currency payment is corrected", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const issued = await app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie },
      payload: {
        customerId: ids.customerId,
        paidOn: "2026-03-15",
        method: "transfer",
        originalCurrency: "USD",
        exchangeRate: "25",
        lines: [{ contractId: ids.contractId, amountCents: lempiras(25_000), type: "installment" }],
      },
    });

    const paymentId = issued.json().receipt.lines[0].paymentId;

    await app.inject({
      method: "PATCH",
      url: `/api/transactions/${paymentId}`,
      headers: { cookie },
      payload: {
        ...editPayload,
        amountCents: lempiras(50_000),
        paidOn: "2026-03-15",
        method: "transfer",
        type: "installment",
      },
    });

    const row = db.select().from(payments).where(eq(payments.id, paymentId)).get()!;

    // L 50,000 at the rate this payment was actually settled at is $2,000 —
    // recomputed from the STORED rate, never from today's.
    assert.equal(row.amountCents, lempiras(50_000));
    assert.equal(row.originalAmountCents, lempiras(2_000));
    assert.equal(row.exchangeRate, "25");

    await app.close();
  });

  it("is not something an associate may do", async () => {
    const { app, db, ids } = await buildTestApp();
    const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/transactions/${firstPayment(db, ids.contractId).id}`,
      headers: { cookie: staffCookie },
      payload: editPayload,
    });

    assert.equal(response.statusCode, 403);

    await app.close();
  });
});

/* -------------------------------------------------------------------------- */
/* Correcting several lines of one receipt at once                             */
/* -------------------------------------------------------------------------- */

describe("correcting the other lines of the same receipt", () => {
  /**
   * A receipt covering two lots, which is what makes the question exist: one
   * amount, one piece of paper, two payment rows.
   */
  async function twoLotReceipt() {
    const built = await buildTestApp();
    const cookie = await login(built.app, "owner@test.hn", OWNER_PASSWORD);
    const secondId = randomUUID();

    built.db
      .insert(contracts)
      .values({
        id: secondId,
        code: "CT-TEST-002",
        lotId: built.ids.freeLotId,
        customerId: built.ids.customerId,
        kind: "contract",
        saleType: "financed",
        status: "active",
        salePriceCents: lempiras(80_000),
        termMonths: 24,
        monthlyPaymentCents: lempiras(3_000),
        dueDay: 5,
        signedOn: "2026-01-10",
      })
      .run();

    const response = await built.app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie },
      payload: {
        customerId: built.ids.customerId,
        paidOn: "2026-03-15",
        method: "cash",
        reference: "BAC-0001",
        lines: [
          { contractId: built.ids.contractId, amountCents: lempiras(20_000), type: "installment" },
          { contractId: secondId, amountCents: lempiras(20_000), type: "installment" },
        ],
      },
    });

    assert.equal(response.statusCode, 201);

    const { receipt } = response.json() as { receipt: any };
    const lines: any[] = receipt.lines;

    return { ...built, cookie, secondId, receipt, lines };
  }

  it("copies the date and method onto the lines that were asked for", async () => {
    const { app, db, cookie, lines } = await twoLotReceipt();

    const edited = lines[0]!;
    const sibling = lines[1]!;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/transactions/${edited.paymentId}`,
      headers: { cookie },
      payload: {
        amountCents: edited.amount,
        paidOn: "2026-03-18",
        method: "transfer",
        type: "installment",
        reference: "BAC-9999",
        notes: null,
        reason: "La fecha y el banco estaban mal en todo el recibo.",
        applyToPaymentIds: [sibling.paymentId],
      },
    });

    assert.equal(response.statusCode, 200);

    const moved = db.select().from(payments).where(eq(payments.id, sibling.paymentId)).get()!;

    assert.equal(moved.paidOn, "2026-03-18");
    assert.equal(moved.method, "transfer");
    assert.equal(moved.reference, "BAC-9999");

    await app.close();
  });

  it("never copies the amount, so the receipt cannot be multiplied", async () => {
    const { app, db, cookie, receipt, lines } = await twoLotReceipt();

    const edited = lines[0]!;
    const sibling = lines[1]!;

    // The amount on the edited line is doubled AND the sibling is named. The
    // sibling must keep its own share: this is the mistake the whole feature is
    // shaped to prevent.
    const response = await app.inject({
      method: "PATCH",
      url: `/api/transactions/${edited.paymentId}`,
      headers: { cookie },
      payload: {
        amountCents: lempiras(40_000),
        paidOn: "2026-03-18",
        method: "cash",
        type: "installment",
        reference: "BAC-0001",
        notes: null,
        reason: "Subiendo el monto de una línea y tocando la otra a propósito.",
        allowOverpayment: true,
        applyToPaymentIds: [sibling.paymentId],
      },
    });

    assert.equal(response.statusCode, 200);

    const moved = db.select().from(payments).where(eq(payments.id, sibling.paymentId)).get()!;

    assert.equal(moved.amountCents, lempiras(20_000));
    assert.equal(moved.paidOn, "2026-03-18");

    const detail = await app.inject({
      method: "GET",
      url: `/api/receipts/${receipt.id}`,
      headers: { cookie },
    });

    // 40,000 + 20,000 — the edited line really did change, and only it did.
    assert.equal((detail.json() as any).receipt.totalPaid, lempiras(60_000));

    await app.close();
  });

  it("writes the same reason to each line's own history", async () => {
    const { app, db, cookie, lines } = await twoLotReceipt();

    const edited = lines[0]!;
    const sibling = lines[1]!;
    const reason = "La fecha y el banco estaban mal en todo el recibo.";

    await app.inject({
      method: "PATCH",
      url: `/api/transactions/${edited.paymentId}`,
      headers: { cookie },
      payload: {
        amountCents: edited.amount,
        paidOn: "2026-03-18",
        method: "transfer",
        type: "installment",
        reference: "BAC-9999",
        notes: null,
        reason,
        applyToPaymentIds: [sibling.paymentId],
      },
    });

    const entries = db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, sibling.paymentId))
      .all();

    const update = entries.find((entry) => entry.action === "update")!;

    assert.ok(update, "the sibling's own history must carry the correction");
    assert.equal(update.reason, reason);
    assert.equal(JSON.parse(update.beforeJson!).paidOn, "2026-03-15");
    assert.equal(JSON.parse(update.afterJson!).paidOn, "2026-03-18");

    await app.close();
  });

  it("refuses to reach a payment that is on a different receipt", async () => {
    const { app, db, ids, cookie, lines } = await twoLotReceipt();

    const other = await app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie },
      payload: {
        customerId: ids.customerId,
        paidOn: "2026-04-15",
        method: "cash",
        lines: [
          { contractId: ids.contractId, amountCents: lempiras(5_000), type: "installment" },
        ],
      },
    });

    const strangerLine = (other.json() as any).receipt.lines[0];
    const edited = lines[0]!;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/transactions/${edited.paymentId}`,
      headers: { cookie },
      payload: {
        amountCents: edited.amount,
        paidOn: "2026-03-18",
        method: "transfer",
        type: "installment",
        reference: null,
        notes: null,
        reason: "Intentando alcanzar una línea de otro recibo.",
        applyToPaymentIds: [strangerLine.paymentId],
      },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "different_receipt");

    // Untouched.
    const untouched = db
      .select()
      .from(payments)
      .where(eq(payments.id, strangerLine.paymentId))
      .get()!;

    assert.equal(untouched.paidOn, "2026-04-15");

    await app.close();
  });

  it("leaves the other lines alone when none was asked for", async () => {
    const { app, db, cookie, lines } = await twoLotReceipt();

    const edited = lines[0]!;
    const sibling = lines[1]!;

    await app.inject({
      method: "PATCH",
      url: `/api/transactions/${edited.paymentId}`,
      headers: { cookie },
      payload: {
        amountCents: edited.amount,
        paidOn: "2026-03-18",
        method: "transfer",
        type: "installment",
        reference: null,
        notes: null,
        reason: "Solo esta línea: la otra se pagó de verdad ese día.",
      },
    });

    const untouched = db.select().from(payments).where(eq(payments.id, sibling.paymentId)).get()!;

    assert.equal(untouched.paidOn, "2026-03-15");
    assert.equal(untouched.method, "cash");

    await app.close();
  });
});
