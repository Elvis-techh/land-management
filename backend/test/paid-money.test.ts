import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";

import { and, eq } from "drizzle-orm";

import { auditEvents, customers, lots } from "../src/db/schema.js";
import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

const lempiras = (amount: number) => Math.round(amount * 100);

interface ContractJson {
  id: string;
  code: string;
  status: string;
  paidToDate: number;
  downPaymentPaid: number;
  balance: number;
  health: { status: string; downPaymentLate: boolean; nextDueOn: string | null };
  paidMoney: {
    carryovers: Array<{ paymentId: string; code: string; amountCents: number; on: string; type: string }>;
    refunds: Array<{ id: string; amountCents: number; returnedOn: string | null; method: string | null }>;
    keptCents: number;
  } | null;
  carriedIn: Array<{ paymentId: string; code: string; amountCents: number; on: string }>;
}

/**
 * «Trasladar lo pagado», on the case it was built for: a contract of
 * L 326,000 with L 86,000 paid in five receipts is replaced by an adenda at
 * L 316,000, with a prima of L 54,000 that the new promesa says was already
 * received. L 54,000 of the old money moves to the new contract as its prima;
 * the other L 32,000 is given back to the person who paid it.
 */
describe("«Trasladar lo pagado» after an adenda", async () => {
  const { app, db, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

  const payer = randomUUID();
  db.insert(customers).values({ id: payer, fullName: "Quien Pagó Antes", customerSince: 2026 }).run();

  const post = (url: string, payload: unknown, cookie = ownerCookie) =>
    app.inject({ method: "POST", url, headers: { cookie }, payload: payload as object });
  const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie: ownerCookie } });

  const contract = async (id: string): Promise<ContractJson> =>
    (await get("/api/contracts")).json().contracts.find((row: ContractJson) => row.id === id);
  const receipt = async (id: string) => (await get(`/api/receipts/${id}`)).json().receipt;
  const november = async () => (await get("/api/dashboard?month=2026-11")).json();

  const lotId = randomUUID();
  db.insert(lots)
    .values({ id: lotId, projectId: ids.projectId, code: "T-07", areaM2: 200, basePriceCents: lempiras(326_000) })
    .run();

  const created = await post("/api/contracts", {
    customerId: payer,
    lotId,
    kind: "contract",
    saleType: "financed",
    salePriceCents: lempiras(326_000),
    downPaymentCents: lempiras(30_000),
    termMonths: 60,
    monthlyPaymentCents: lempiras(6_000),
    dueDay: 20,
    signedOn: "2026-06-10",
    firstDueOn: "2026-08-25",
  });
  assert.equal(created.statusCode, 201, created.body);
  const oldId = created.json().contract.id as string;

  const pay = async (paidOn: string, amount: number, type = "installment") => {
    const response = await post("/api/receipts", {
      customerId: payer,
      paidOn,
      method: "transfer",
      lines: [{ contractId: oldId, amountCents: lempiras(amount), type }],
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().receipt.id as string;
  };

  const oldReceipts = [
    await pay("2026-06-10", 38_000, "down_payment"),
    await pay("2026-07-27", 30_000),
    await pay("2026-08-25", 6_000),
    await pay("2026-09-01", 6_000),
    await pay("2026-10-01", 6_000),
  ];

  const amended = await post("/api/contracts/amendments", {
    effectiveOn: "2026-11-05",
    saleType: "financed",
    termMonths: 44,
    dueDay: 30,
    firstDueOn: "2026-12-30",
    lines: [
      {
        contractId: oldId,
        salePriceCents: lempiras(316_000),
        downPaymentCents: lempiras(54_000),
        monthlyPaymentCents: lempiras(6_000),
      },
    ],
    reason: "Nueva promesa de venta: L 316,000, prima L 54,000 ya recibida.",
  });
  assert.equal(amended.statusCode, 201, amended.body);
  const newId = amended.json().contracts[0].id as string;

  const printedBefore = await Promise.all(oldReceipts.map(receipt));
  const collectedBefore = (await november()).income.collectedCents as number;

  const decide = (payload: object, cookie = ownerCookie) =>
    post(
      `/api/contracts/${oldId}/paid-money`,
      {
        carryoverCents: lempiras(54_000),
        carryoverType: "down_payment",
        carryoverOn: "2026-11-05",
        refundCents: lempiras(32_000),
        reason: "La prima de la nueva promesa sale de lo pagado; el resto se devuelve.",
        ...payload,
      },
      cookie,
    );

  it("starts with the new contract owing its whole prima, and everything left as income", async () => {
    const replacement = await contract(newId);
    assert.equal(replacement.paidToDate, 0);
    assert.equal(replacement.health.downPaymentLate, true);
    assert.equal((await contract(oldId)).paidMoney, null);
  });

  it("is not something an associate may do by default", async () => {
    assert.equal((await decide({}, staffCookie)).statusCode, 403);
  });

  it("demands a written motive", async () => {
    assert.equal((await decide({ reason: "prima" })).statusCode, 400);
  });

  it("refuses more than was paid on the old contract", async () => {
    const response = await decide({ refundCents: lempiras(32_001) });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "exceeds_paid");
  });

  it("refuses deciding nothing", async () => {
    const response = await decide({ carryoverCents: 0, refundCents: 0 });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "nothing_to_decide");
  });

  it("refuses a traslado dated before the new contract was signed, or in the future", async () => {
    assert.equal((await decide({ carryoverOn: "2026-11-04" })).json().error, "before_signing");
    assert.equal((await decide({ carryoverOn: "2099-01-01" })).json().error, "future_date");
  });

  it("refuses on a contract that no adenda replaced", async () => {
    const response = await post(`/api/contracts/${newId}/paid-money`, {
      carryoverCents: 0,
      refundCents: lempiras(1),
      reason: "Esto no debería poder hacerse aquí.",
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "not_replaced");
  });

  it("moves L 54,000 to the new contract as its prima and owes L 32,000 back", async () => {
    const response = await decide({});
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().undecidedCents, 0);

    const replacement = await contract(newId);
    assert.equal(replacement.paidToDate, lempiras(54_000));
    assert.equal(replacement.downPaymentPaid, lempiras(54_000));
    assert.equal(replacement.balance, lempiras(262_000));
    assert.equal(replacement.health.downPaymentLate, false);
    assert.equal(replacement.health.nextDueOn, "2026-12-30");
    assert.equal(replacement.carriedIn.length, 1);
    assert.equal(replacement.carriedIn[0]!.amountCents, lempiras(54_000));

    const old = await contract(oldId);
    assert.equal(old.paidToDate, lempiras(86_000));
    assert.equal(old.paidMoney!.carryovers.length, 1);
    assert.equal(old.paidMoney!.carryovers[0]!.code, (await contract(newId)).code);
    assert.equal(old.paidMoney!.refunds.length, 1);
    assert.equal(old.paidMoney!.refunds[0]!.amountCents, lempiras(32_000));
    assert.equal(old.paidMoney!.refunds[0]!.returnedOn, null);
    assert.equal(old.paidMoney!.keptCents, 0);
  });

  it("leaves nothing more to decide", async () => {
    const response = await decide({ carryoverCents: 0, refundCents: lempiras(1) });
    assert.equal(response.json().error, "exceeds_paid");
  });

  it("does not touch a single receipt of the old contract", async () => {
    const printedAfter = await Promise.all(oldReceipts.map(receipt));
    assert.deepEqual(printedAfter, printedBefore);
  });

  it("does not count the traslado as money collected in November", async () => {
    const panel = await november();
    assert.equal(panel.income.collectedCents, collectedBefore);
    assert.equal(panel.control.refunds.pending.length, 1);
    assert.equal(panel.control.refunds.pending[0].amountCents, lempiras(32_000));
    assert.equal(panel.control.refunds.returned.length, 0);
  });

  it("lists the traslado as a line from the old contract, which «Corregir» refuses", async () => {
    const rows = (await get("/api/transactions")).json().transactions as Array<{
      id: string;
      contractId: string;
      receiptId: string | null;
      carriedFromCode?: string;
    }>;
    const line = rows.find((row) => row.contractId === newId)!;
    assert.equal(line.receiptId, null);
    assert.equal(line.carriedFromCode, (await contract(oldId)).code);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/transactions/${line.id}`,
      headers: { cookie: ownerCookie },
      payload: {
        amountCents: lempiras(60_000),
        paidOn: "2026-11-05",
        method: "cash",
        type: "down_payment",
        reason: "Intento de cambiar el traslado desde aquí.",
      },
    });
    assert.equal(patched.statusCode, 409);
    assert.equal(patched.json().error, "carryover");
  });

  it("makes the next receipt on the new contract start from L 262,000", async () => {
    const response = await post("/api/receipts", {
      customerId: payer,
      paidOn: "2026-11-24",
      method: "cash",
      lines: [{ contractId: newId, amountCents: lempiras(6_000), type: "installment" }],
    });
    assert.equal(response.statusCode, 201, response.body);
    const printed = await receipt(response.json().receipt.id);
    assert.equal(printed.previousBalance, lempiras(262_000));
    assert.equal(printed.cumulativePaid, lempiras(60_000));
  });

  it("refuses refunding the new contract's traslado through «Cancelar»", async () => {
    const response = await post(`/api/contracts/${newId}/cancel`, {
      reason: "Probando que el traslado no se reembolsa desde aquí.",
      settlement: "refunded",
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "carryover_refund");
  });

  it("records the day the L 32,000 is handed back, and only then counts it as money out", async () => {
    const refund = (await contract(oldId)).paidMoney!.refunds[0]!;

    assert.equal(
      (await post(`/api/refunds/${refund.id}/return`, { returnedOn: "2099-01-01", method: "cash" })).json().error,
      "future_date",
    );

    const response = await post(`/api/refunds/${refund.id}/return`, {
      returnedOn: "2026-11-20",
      method: "cash",
    });
    assert.equal(response.statusCode, 200, response.body);

    const again = await post(`/api/refunds/${refund.id}/return`, { returnedOn: "2026-11-20", method: "cash" });
    assert.equal(again.json().error, "already_returned");

    const back = (await contract(oldId)).paidMoney!.refunds[0]!;
    assert.equal(back.returnedOn, "2026-11-20");
    assert.equal(back.method, "cash");

    const panel = await november();
    assert.equal(panel.control.refunds.pending.length, 0);
    assert.equal(panel.control.refunds.returned.length, 1);
    // «Cobrado» counts what came in; what went out is listed beside it.
    assert.equal(panel.income.collectedCents, collectedBefore + lempiras(6_000));
  });

  it("takes a traslado back, leaving that money undecided on the old contract again", async () => {
    const moved = (await contract(oldId)).paidMoney!.carryovers[0]!;
    const response = await post(`/api/carryovers/${moved.paymentId}/remove`, {
      reason: "Se registró con la fecha equivocada.",
    });
    assert.equal(response.statusCode, 200, response.body);

    assert.equal((await contract(newId)).paidToDate, lempiras(6_000));
    const old = await contract(oldId);
    assert.equal(old.paidMoney!.carryovers.length, 0);
    assert.equal(old.paidMoney!.keptCents, lempiras(54_000));

    // And it can be decided again.
    const redo = await decide({ refundCents: 0 });
    assert.equal(redo.statusCode, 201, redo.body);
    assert.equal((await contract(newId)).paidToDate, lempiras(60_000));
  });

  it("files every step in the Historial", async () => {
    const rows = db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, oldId), eq(auditEvents.action, "paid_money")))
      .all();

    // The boundary probe and its removal, the decision, the return, the
    // removal and the second decision.
    assert.ok(rows.length >= 4, `${rows.length} rows`);
    const decision = rows.find((row) => JSON.parse(row.afterJson!).refundCents === lempiras(32_000));
    assert.ok(decision);
    assert.deepEqual(JSON.parse(decision.beforeJson!), { keptCents: lempiras(86_000) });
  });
});

describe("a traslado larger than what the new contract owes", async () => {
  const { app, db, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const post = (url: string, payload: unknown) =>
    app.inject({ method: "POST", url, headers: { cookie }, payload: payload as object });

  const payer = randomUUID();
  db.insert(customers).values({ id: payer, fullName: "Pagó de Más", customerSince: 2026 }).run();
  const lotId = randomUUID();
  db.insert(lots)
    .values({ id: lotId, projectId: ids.projectId, code: "Z-01", areaM2: 200, basePriceCents: lempiras(100_000) })
    .run();

  const oldId = (
    await post("/api/contracts", {
      customerId: payer,
      lotId,
      kind: "contract",
      saleType: "financed",
      salePriceCents: lempiras(100_000),
      downPaymentCents: lempiras(10_000),
      termMonths: 10,
      monthlyPaymentCents: lempiras(9_000),
      dueDay: 5,
      signedOn: "2026-03-01",
    })
  ).json().contract.id as string;
  await post("/api/receipts", {
    customerId: payer,
    paidOn: "2026-03-01",
    method: "cash",
    lines: [{ contractId: oldId, amountCents: lempiras(50_000), type: "down_payment" }],
  });
  await post("/api/contracts/amendments", {
    effectiveOn: "2026-10-01",
    saleType: "cash",
    lines: [{ contractId: oldId, salePriceCents: lempiras(40_000), downPaymentCents: 0 }],
    reason: "Se queda con un lote más chico, de contado.",
  });

  it("refuses it: the new contract would owe less than nothing", async () => {
    const response = await post(`/api/contracts/${oldId}/paid-money`, {
      carryoverCents: lempiras(45_000),
      carryoverType: "installment",
      carryoverOn: "2026-10-01",
      refundCents: 0,
      reason: "Todo lo pagado pasa al contrato nuevo.",
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "overpayment");
    assert.equal(response.json().owedCents, lempiras(40_000));
  });
});
