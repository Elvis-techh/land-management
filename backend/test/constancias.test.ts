import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";

import { lots } from "../src/db/schema.js";
import { CONSTANCIA_CODE_PATTERN } from "../src/lib/constancias.js";
import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

const lempiras = (amount: number) => Math.round(amount * 100);

describe("a constancia de cancelación total", async () => {
  const { app, db, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

  const post = (url: string, payload: Record<string, unknown> = {}, cookie = ownerCookie) =>
    app.inject({ method: "POST", url, headers: { cookie }, payload });
  const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie: ownerCookie } });

  let lotNumber = 0;

  /** A financed L 50,000 contract on a lot of its own, L 10,000 prima and L 5,000 cuotas. */
  const newContract = async () => {
    lotNumber += 1;
    const lotId = randomUUID();
    db.insert(lots)
      .values({
        id: lotId,
        projectId: ids.projectId,
        code: `CT-${lotNumber}`,
        areaM2: 300,
        basePriceCents: lempiras(50_000),
      })
      .run();

    return (
      await post("/api/contracts", {
        customerId: ids.customerId,
        lotId,
        kind: "contract",
        saleType: "financed",
        salePriceCents: lempiras(50_000),
        downPaymentCents: lempiras(10_000),
        termMonths: 8,
        monthlyPaymentCents: lempiras(5_000),
        dueDay: 5,
        signedOn: "2026-01-10",
      })
    ).json().contract.id as string;
  };

  const pay = async (contractId: string, paidOn: string, amount: number, type = "installment") =>
    (
      await post("/api/receipts", {
        customerId: ids.customerId,
        paidOn,
        method: "cash",
        lines: [{ contractId, amountCents: lempiras(amount), type }],
      })
    ).json().receipt;

  const issue = (contractId: string, cookie = ownerCookie) =>
    post(`/api/contracts/${contractId}/constancia`, {}, cookie);

  it("is refused while the contract still owes money", async () => {
    const contractId = await newContract();
    await pay(contractId, "2026-01-10", 10_000, "down_payment");

    const response = await issue(contractId);

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "not_paid_off");
  });

  it("is only for the supervisor until an associate is given it", async () => {
    const contractId = await newContract();
    await pay(contractId, "2026-01-10", 50_000, "full_payment");

    const response = await issue(contractId, staffCookie);

    assert.equal(response.statusCode, 403);
  });

  it("states the contract, the customer and every payment that counts", async () => {
    const contractId = await newContract();
    const prima = await pay(contractId, "2026-01-10", 10_000, "down_payment");
    await pay(contractId, "2026-02-05", 5_000);
    await pay(contractId, "2026-03-05", 35_000, "full_payment");

    const response = await issue(contractId);
    assert.equal(response.statusCode, 200);

    const { constancia } = response.json();

    assert.match(constancia.code, CONSTANCIA_CODE_PATTERN);
    assert.match(constancia.lookupCode, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    assert.equal(constancia.voidedAt, null);
    assert.equal(constancia.contract.salePriceCents, lempiras(50_000));
    assert.equal(constancia.customer.fullName.length > 0, true);
    assert.equal(constancia.totalPaidCents, lempiras(50_000));
    assert.equal(constancia.lastPaidOn, "2026-03-05");
    assert.deepEqual(
      constancia.payments.map((payment: { paidOn: string; amountCents: number }) => [
        payment.paidOn,
        payment.amountCents,
      ]),
      [
        ["2026-01-10", lempiras(10_000)],
        ["2026-02-05", lempiras(5_000)],
        ["2026-03-05", lempiras(35_000)],
      ],
    );
    assert.equal(constancia.payments[0].receiptCode, prima.code);
    assert.equal(constancia.payments[0].type, "down_payment");
  });

  it("is issued once: asking again hands back the same one", async () => {
    const contractId = await newContract();
    await pay(contractId, "2026-01-10", 50_000, "full_payment");

    const first = (await issue(contractId)).json().constancia;
    const second = (await issue(contractId)).json().constancia;

    assert.equal(second.id, first.id);
    assert.equal(second.code, first.code);
    assert.equal((await get(`/api/contracts/${contractId}/constancia`)).json().constancia.id, first.id);
  });

  it("is verified from its code, however it is typed", async () => {
    const contractId = await newContract();
    await pay(contractId, "2026-01-10", 50_000, "full_payment");
    const { constancia } = (await issue(contractId)).json();

    const typed = constancia.lookupCode.replace("-", "").toLowerCase();
    const found = await get(`/api/constancias/lookup/${typed}`);

    assert.equal(found.statusCode, 200);
    assert.equal(found.json().constancia.id, constancia.id);
    assert.equal((await get("/api/constancias/lookup/NOPE")).statusCode, 400);
    assert.equal((await get("/api/constancias/lookup/ZZZZ-ZZZZ")).statusCode, 404);
  });

  it("is voided when the contract owes money again, and a new one follows payment", async () => {
    const contractId = await newContract();
    const receipt = await pay(contractId, "2026-01-10", 50_000, "full_payment");
    const original = (await issue(contractId)).json().constancia;

    const voided = await post(`/api/receipts/${receipt.id}/void`, { reason: "Cheque rebotado" });
    assert.equal(voided.statusCode, 200);

    const looked = (await get(`/api/constancias/lookup/${original.lookupCode}`)).json().constancia;
    assert.notEqual(looked.voidedAt, null, "the code now reads ANULADA");
    assert.match(looked.voidReason, /saldo pendiente/);
    assert.equal((await get(`/api/contracts/${contractId}/constancia`)).json().constancia, null);
    assert.equal((await issue(contractId)).statusCode, 409);

    await pay(contractId, "2026-01-20", 50_000, "full_payment");
    const replacement = (await issue(contractId)).json().constancia;

    assert.notEqual(replacement.id, original.id);
    assert.notEqual(replacement.code, original.code);
  });

  it("is voided when a paid-off contract is cancelled", async () => {
    const contractId = await newContract();
    await pay(contractId, "2026-01-10", 50_000, "full_payment");
    const { constancia } = (await issue(contractId)).json();

    const cancelled = await post(`/api/contracts/${contractId}/cancel`, {
      reason: "Acuerdo con el cliente",
      settlement: "none",
    });
    assert.equal(cancelled.statusCode, 200);

    const looked = (await get(`/api/constancias/${constancia.id}`)).json().constancia;
    assert.notEqual(looked.voidedAt, null);
    assert.match(looked.voidReason, /cancelado: Acuerdo con el cliente/);
  });
});
