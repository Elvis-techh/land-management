import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { contracts, customers, payments } from "../src/db/schema.js";
import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

const lempiras = (amount: number) => Math.round(amount * 100);

type TestDb = Awaited<ReturnType<typeof buildTestApp>>["db"];

/**
 * A second contract for the SAME customer, so the multi-lot receipt — one
 * signature, one payment, two balances — can be exercised.
 */
function addSecondContract(db: TestDb, ids: { customerId: string; freeLotId: string }) {
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

describe("issuing a receipt", () => {
  it("records the transactions and derives every figure on the document", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    // The seeded contract is L 185,000 with L 15,000 already paid.
    const response = await app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie },
      payload: {
        customerId: ids.customerId,
        paidOn: "2026-03-15",
        method: "cash",
        lines: [
          { contractId: ids.contractId, amountCents: lempiras(6_700), type: "installment" },
        ],
      },
    });

    assert.equal(response.statusCode, 201);

    const { receipt } = response.json() as { receipt: Record<string, any> };

    // The sequence is internal; the printed code is random and fixed-width.
    assert.equal(receipt.number, 1);
    assert.match(receipt.code, /^IM-\d{12}$/);
    assert.match(receipt.lookupCode, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    assert.equal(receipt.totalPaid, lempiras(6_700));

    // 185,000 − 15,000 already paid = 170,000 before this one.
    assert.equal(receipt.previousBalance, lempiras(170_000));
    assert.equal(receipt.newBalance, lempiras(163_300));
    assert.equal(receipt.cumulativePaid, lempiras(21_700));

    // The face of the document has to add up.
    assert.equal(receipt.previousBalance - receipt.totalPaid, receipt.newBalance);

    await app.close();
  });

  it("splits one payment across several lots and shows a balance for each", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
    const secondId = addSecondContract(db, ids);

    const response = await app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie },
      payload: {
        customerId: ids.customerId,
        paidOn: "2026-03-15",
        method: "transfer",
        reference: "BAC-889231",
        lines: [
          { contractId: ids.contractId, amountCents: lempiras(6_700), type: "installment" },
          { contractId: secondId, amountCents: lempiras(3_000), type: "installment" },
        ],
      },
    });

    assert.equal(response.statusCode, 201);

    const { receipt } = response.json() as { receipt: Record<string, any> };

    assert.equal(receipt.transactionCount, 2);
    assert.equal(receipt.totalPaid, lempiras(9_700));

    // One receipt, two lots, two independent balances.
    assert.equal(receipt.lines.length, 2);
    assert.equal(receipt.previousBalance, lempiras(250_000));
    assert.equal(receipt.newBalance, lempiras(240_300));
    assert.equal(receipt.previousBalance - receipt.totalPaid, receipt.newBalance);

    const lotLine = receipt.lines.find((line: any) => line.contractId === secondId);
    assert.equal(lotLine.previousBalance, lempiras(80_000));
    assert.equal(lotLine.newBalance, lempiras(77_000));

    await app.close();
  });

  it("says which cuota the money went towards", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
    const secondId = addSecondContract(db, ids);

    // L 10,000 prima, then L 3,000 a month. This pays the prima's remainder
    // plus the first cuota.
    const response = await app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie },
      payload: {
        customerId: ids.customerId,
        paidOn: "2026-02-05",
        method: "cash",
        lines: [{ contractId: secondId, amountCents: lempiras(13_000), type: "installment" }],
      },
    });

    const { receipt } = response.json() as { receipt: Record<string, any> };
    const applied = receipt.lines[0].appliedTo;

    // The prima is not cuota 1 — the schedule covers the financed part only.
    assert.equal(applied.length, 1);
    assert.equal(applied[0].number, 1);
    assert.equal(applied[0].appliedCents, lempiras(3_000));
    assert.equal(applied[0].settled, true);

    await app.close();
  });

  it("refuses money for a contract that is not this customer's", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const strangerContract = randomUUID();
    const strangerCustomer = randomUUID();

    db.insert(customers)
      .values({
        id: strangerCustomer,
        fullName: "Otro Cliente",
        identification: "0801-1990-00002",
        phone: "+50499990001",
        customerSince: 2025,
      })
      .run();

    db.insert(contracts)
      .values({
        id: strangerContract,
        code: "CT-TEST-099",
        lotId: ids.freeLotId,
        customerId: strangerCustomer,
        kind: "contract",
        status: "active",
        salePriceCents: lempiras(50_000),
      })
      .run();

    const response = await app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie },
      payload: {
        customerId: ids.customerId,
        paidOn: "2026-03-15",
        method: "cash",
        lines: [{ contractId: strangerContract, amountCents: lempiras(1_000), type: "installment" }],
      },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "contract_not_customers");

    await app.close();
  });

  it("refuses an overpayment until it is confirmed, then allows it", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    // The contract owes L 170,000. A typed extra zero must not become a silent
    // credit nobody can explain.
    const payload = {
      customerId: ids.customerId,
      paidOn: "2026-03-15",
      method: "cash",
      lines: [{ contractId: ids.contractId, amountCents: lempiras(1_700_000), type: "installment" }],
    };

    const refused = await app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie },
      payload,
    });

    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().error, "overpayment");
    assert.equal(refused.json().balanceCents, lempiras(170_000));

    const allowed = await app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie },
      payload: { ...payload, allowOverpayment: true },
    });

    assert.equal(allowed.statusCode, 201);
    assert.equal(allowed.json().receipt.newBalance, 0);

    await app.close();
  });

  it("refuses two lines against the same contract", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const response = await app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie },
      payload: {
        customerId: ids.customerId,
        paidOn: "2026-03-15",
        method: "cash",
        lines: [
          { contractId: ids.contractId, amountCents: lempiras(1_000), type: "installment" },
          { contractId: ids.contractId, amountCents: lempiras(2_000), type: "installment" },
        ],
      },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "duplicate_contract");

    await app.close();
  });

  it("keeps the dollar figures adding up to what was handed over", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
    const secondId = addSecondContract(db, ids);

    // $1,000 at 26.50 is L 26,500, split unevenly across two lots. The dollar
    // column has to sum to exactly $1,000 or the receipt is worthless.
    const response = await app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie },
      payload: {
        customerId: ids.customerId,
        paidOn: "2026-03-15",
        method: "transfer",
        originalCurrency: "USD",
        exchangeRate: "26.50",
        lines: [
          { contractId: ids.contractId, amountCents: lempiras(16_333.33), type: "installment" },
          { contractId: secondId, amountCents: lempiras(10_166.67), type: "installment" },
        ],
      },
    });

    assert.equal(response.statusCode, 201);

    const rows = db
      .select({
        originalAmountCents: payments.originalAmountCents,
        originalCurrency: payments.originalCurrency,
        exchangeRate: payments.exchangeRate,
      })
      .from(payments)
      .where(eq(payments.receiptId, response.json().receipt.id))
      .all();

    const totalOriginal = rows.reduce((sum, row) => sum + row.originalAmountCents, 0);

    assert.equal(totalOriginal, lempiras(1_000));
    assert.equal(rows[0]!.originalCurrency, "USD");
    assert.equal(rows[0]!.exchangeRate, "26.50");

    await app.close();
  });

  it("refuses a tipo de cambio on a lempira payment", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const response = await app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie },
      payload: {
        customerId: ids.customerId,
        paidOn: "2026-03-15",
        method: "cash",
        originalCurrency: "HNL",
        exchangeRate: "26.50",
        lines: [{ contractId: ids.contractId, amountCents: lempiras(1_000), type: "installment" }],
      },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "invalid_rate");

    await app.close();
  });
});

describe("receipt numbering", () => {
  it("never reuses a number, even after a void", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const issue = (paidOn: string) =>
      app.inject({
        method: "POST",
        url: "/api/receipts",
        headers: { cookie },
        payload: {
          customerId: ids.customerId,
          paidOn,
          method: "cash",
          lines: [{ contractId: ids.contractId, amountCents: lempiras(1_000), type: "installment" }],
        },
      });

    const first = await issue("2026-03-15");
    const second = await issue("2026-03-16");

    assert.equal(first.json().receipt.number, 1);
    assert.equal(second.json().receipt.number, 2);

    await app.inject({
      method: "POST",
      url: `/api/receipts/${second.json().receipt.id}/void`,
      headers: { cookie },
      payload: { reason: "Cobrado por duplicado en ventanilla." },
    });

    // A count would hand out 2 again here. Two documents claiming the same
    // number is unrecoverable, so the sequence walks past the void.
    const third = await issue("2026-03-17");
    assert.equal(third.json().receipt.number, 3);

    // …and the printed code carries none of that: it is drawn fresh, so the
    // paper does not tell the customer how many receipts have been issued.
    assert.match(third.json().receipt.code, /^IM-\d{12}$/);
    assert.notEqual(third.json().receipt.code, second.json().receipt.code);

    await app.close();
  });

  it("gives every receipt a different lookup code", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const codes = new Set<string>();

    for (let index = 0; index < 5; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/receipts",
        headers: { cookie },
        payload: {
          customerId: ids.customerId,
          paidOn: "2026-03-15",
          method: "cash",
          lines: [{ contractId: ids.contractId, amountCents: lempiras(500), type: "installment" }],
        },
      });

      codes.add(response.json().receipt.lookupCode);
    }

    assert.equal(codes.size, 5);

    await app.close();
  });

  it("finds a receipt by a lookup code typed with the wrong lookalike characters", async () => {
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

    const code: string = issued.json().receipt.lookupCode;

    // Lowercase, no hyphen, and every 0 read as the letter O — what a customer
    // reading it off a printed receipt actually types.
    const mistyped = code.toLowerCase().replace("-", "").replace(/0/g, "o");

    const found = await app.inject({
      method: "GET",
      url: `/api/receipts/lookup/${mistyped}`,
      headers: { cookie },
    });

    assert.equal(found.statusCode, 200);
    assert.equal(found.json().receipt.id, issued.json().receipt.id);

    await app.close();
  });

  it("refuses a lookup code that is not one, rather than searching for it", async () => {
    const { app } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const response = await app.inject({
      method: "GET",
      url: "/api/receipts/lookup/IM-482739156034",
      headers: { cookie },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "invalid_lookup_code");

    await app.close();
  });
});

describe("correcting history", () => {
  it("re-derives an older receipt when a payment before it is corrected", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const issue = (paidOn: string, amount: number) =>
      app.inject({
        method: "POST",
        url: "/api/receipts",
        headers: { cookie },
        payload: {
          customerId: ids.customerId,
          paidOn,
          method: "cash",
          lines: [{ contractId: ids.contractId, amountCents: amount, type: "installment" }],
        },
      });

    const march = await issue("2026-03-15", lempiras(6_700));
    const april = await issue("2026-04-15", lempiras(6_700));

    const aprilId: string = april.json().receipt.id;

    const readApril = async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/receipts/${aprilId}`,
        headers: { cookie },
      });
      return response.json().receipt;
    };

    assert.equal((await readApril()).previousBalance, lempiras(163_300));

    // Two months later, the March transaction is found to have been L 10,000.
    // This is the owner's stated case, and nothing is locked or frozen.
    const marchPaymentId = db
      .select({ id: payments.id })
      .from(payments)
      .where(eq(payments.receiptId, march.json().receipt.id))
      .get()!.id;

    db.update(payments)
      .set({ amountCents: lempiras(10_000) })
      .where(eq(payments.id, marchPaymentId))
      .run();

    const corrected = await readApril();

    // April's receipt moved by exactly the correction, and still balances.
    assert.equal(corrected.previousBalance, lempiras(160_000));
    assert.equal(corrected.previousBalance - corrected.totalPaid, corrected.newBalance);
    assert.equal(corrected.cumulativePaid, lempiras(31_700));

    await app.close();
  });

  it("re-derives every receipt when the sale price itself is corrected", async () => {
    const { app, db, ids } = await buildTestApp();
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

    db.update(contracts)
      .set({ salePriceCents: lempiras(200_000) })
      .where(eq(contracts.id, ids.contractId))
      .run();

    const reread = await app.inject({
      method: "GET",
      url: `/api/receipts/${issued.json().receipt.id}`,
      headers: { cookie },
    });

    assert.equal(reread.json().receipt.previousBalance, lempiras(185_000));
    assert.equal(reread.json().receipt.newBalance, lempiras(178_300));

    await app.close();
  });

  it("slots a back-dated transaction into its real place in the history", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const issue = (paidOn: string, amount: number) =>
      app.inject({
        method: "POST",
        url: "/api/receipts",
        headers: { cookie },
        payload: {
          customerId: ids.customerId,
          paidOn,
          method: "cash",
          lines: [{ contractId: ids.contractId, amountCents: amount, type: "installment" }],
        },
      });

    const april = await issue("2026-04-15", lempiras(6_700));
    const aprilId: string = april.json().receipt.id;

    // Recorded today, but the money arrived in March. April's document must
    // move; the receipt number does not.
    await issue("2026-03-01", lempiras(5_000));

    const reread = await app.inject({
      method: "GET",
      url: `/api/receipts/${aprilId}`,
      headers: { cookie },
    });

    assert.equal(reread.json().receipt.previousBalance, lempiras(165_000));
    assert.equal(reread.json().receipt.number, 1);

    await app.close();
  });
});

describe("voiding a receipt", () => {
  it("reverses the money, keeps the document, and frees the balance", async () => {
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

    const receiptId: string = issued.json().receipt.id;

    const voided = await app.inject({
      method: "POST",
      url: `/api/receipts/${receiptId}/void`,
      headers: { cookie },
      payload: { reason: "El cheque del cliente fue rechazado por el banco." },
    });

    assert.equal(voided.statusCode, 200);
    assert.ok(voided.json().receipt.voidedAt);
    assert.equal(
      voided.json().receipt.voidReason,
      "El cheque del cliente fue rechazado por el banco.",
    );

    // The amount on the face of the document is what it always said.
    assert.equal(voided.json().receipt.totalPaid, lempiras(6_700));

    // But the money no longer counts anywhere: the contract is back where it was.
    const contract = await app.inject({
      method: "GET",
      url: "/api/contracts",
      headers: { cookie },
    });

    const row = contract
      .json()
      .contracts.find((entry: any) => entry.id === ids.contractId);

    assert.equal(row.paidToDate, lempiras(15_000));
    assert.equal(row.balance, lempiras(170_000));

    await app.close();
  });

  it("refuses to void the same receipt twice", async () => {
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

    const url = `/api/receipts/${issued.json().receipt.id}/void`;
    const payload = { reason: "Anulado por error de digitación en ventanilla." };

    await app.inject({ method: "POST", url, headers: { cookie }, payload });
    const second = await app.inject({ method: "POST", url, headers: { cookie }, payload });

    assert.equal(second.statusCode, 409);
    assert.equal(second.json().error, "already_voided");

    await app.close();
  });

  it("insists on a reason", async () => {
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

    const response = await app.inject({
      method: "POST",
      url: `/api/receipts/${issued.json().receipt.id}/void`,
      headers: { cookie },
      payload: { reason: "error" },
    });

    assert.equal(response.statusCode, 400);

    await app.close();
  });
});

describe("not taking the money twice", () => {
  it("answers a repeated submission with the receipt it already issued", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const payload = {
      customerId: ids.customerId,
      paidOn: "2026-03-15",
      method: "cash",
      idempotencyKey: "field-phone-4f9c2a71",
      lines: [{ contractId: ids.contractId, amountCents: lempiras(6_700), type: "installment" }],
    };

    const first = await app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie },
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie },
      payload,
    });

    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().duplicate, true);
    assert.equal(second.json().receipt.id, first.json().receipt.id);

    // One receipt, one payment — not two of either.
    const rows = db.select().from(payments).where(eq(payments.contractId, ids.contractId)).all();
    assert.equal(rows.filter((row) => row.receiptId !== null).length, 1);

    await app.close();
  });
});

describe("permissions and history", () => {
  it("lets an associate record a payment but not void a receipt", async () => {
    const { app, ids } = await buildTestApp();
    const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

    const issued = await app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie: staffCookie },
      payload: {
        customerId: ids.customerId,
        paidOn: "2026-03-15",
        method: "cash",
        lines: [{ contractId: ids.contractId, amountCents: lempiras(1_000), type: "installment" }],
      },
    });

    assert.equal(issued.statusCode, 201);

    const voided = await app.inject({
      method: "POST",
      url: `/api/receipts/${issued.json().receipt.id}/void`,
      headers: { cookie: staffCookie },
      payload: { reason: "Intento de anulación sin permiso suficiente." },
    });

    assert.equal(voided.statusCode, 403);

    await app.close();
  });

  it("refuses an anonymous request outright", async () => {
    const { app, ids } = await buildTestApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/receipts",
      payload: {
        customerId: ids.customerId,
        paidOn: "2026-03-15",
        method: "cash",
        lines: [{ contractId: ids.contractId, amountCents: lempiras(1_000), type: "installment" }],
      },
    });

    assert.equal(response.statusCode, 401);

    await app.close();
  });

  it("files the issue and the void in the history", async () => {
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
      payload: { reason: "Depósito no acreditado por el banco emisor." },
    });

    const history = await app.inject({ method: "GET", url: "/api/audit", headers: { cookie } });
    const events = history
      .json()
      .events.filter((event: any) => event.entityId === issued.json().receipt.id);

    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((event: any) => event.action).sort(),
      ["create", "reverse"],
    );

    await app.close();
  });
});

describe("the receipts list", () => {
  it("agrees exactly with the receipt it links to", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    for (const [paidOn, amount] of [
      ["2026-03-15", lempiras(6_700)],
      ["2026-04-15", lempiras(6_700)],
      ["2026-05-15", lempiras(6_700)],
    ] as const) {
      await app.inject({
        method: "POST",
        url: "/api/receipts",
        headers: { cookie },
        payload: {
          customerId: ids.customerId,
          paidOn,
          method: "cash",
          lines: [{ contractId: ids.contractId, amountCents: amount, type: "installment" }],
        },
      });
    }

    const list = await app.inject({ method: "GET", url: "/api/receipts", headers: { cookie } });
    const rows = list.json().receipts as any[];

    // Newest first.
    assert.deepEqual(
      rows.map((row) => row.number),
      [3, 2, 1],
    );

    // Every figure on the list matches the detail screen, because both come
    // from the same replay.
    for (const row of rows) {
      const detail = await app.inject({
        method: "GET",
        url: `/api/receipts/${row.id}`,
        headers: { cookie },
      });

      const one = detail.json().receipt;

      assert.equal(row.previousBalance, one.previousBalance);
      assert.equal(row.newBalance, one.newBalance);
      assert.equal(row.cumulativePaid, one.cumulativePaid);
      assert.equal(row.totalPaid, one.totalPaid);
    }

    await app.close();
  });
});
