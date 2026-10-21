import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";

import { customers, lots } from "../src/db/schema.js";
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

  const issue = (contractId: string | string[], cookie = ownerCookie) =>
    post("/api/constancias", { contractIds: [contractId].flat() }, cookie);
  const standing = async (contractId: string) =>
    (await get(`/api/contracts/${contractId}/constancias`)).json().standing as Array<{ id: string }>;

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
    assert.equal(constancia.parts.length, 1);
    assert.equal(constancia.salePriceCents, lempiras(50_000));
    assert.equal(constancia.customer.fullName.length > 0, true);
    assert.equal(constancia.totalPaidCents, lempiras(50_000));
    assert.equal(constancia.lastPaidOn, "2026-03-05");
    assert.deepEqual(
      constancia.parts[0].payments.map((payment: { paidOn: string; amountCents: number }) => [
        payment.paidOn,
        payment.amountCents,
      ]),
      [
        ["2026-01-10", lempiras(10_000)],
        ["2026-02-05", lempiras(5_000)],
        ["2026-03-05", lempiras(35_000)],
      ],
    );
    assert.equal(constancia.parts[0].payments[0].receiptCode, prima.code);
    assert.equal(constancia.parts[0].payments[0].type, "down_payment");
  });

  it("is issued once: asking again hands back the same one", async () => {
    const contractId = await newContract();
    await pay(contractId, "2026-01-10", 50_000, "full_payment");

    const first = (await issue(contractId)).json().constancia;
    const second = (await issue(contractId)).json().constancia;

    assert.equal(second.id, first.id);
    assert.equal(second.code, first.code);
    assert.deepEqual((await standing(contractId)).map((c) => c.id), [first.id]);
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
    assert.deepEqual(await standing(contractId), []);
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

  describe("for several lots at once", () => {
    it("speaks for every lot chosen, with their values added up", async () => {
      const first = await newContract();
      const second = await newContract();
      await pay(first, "2026-01-10", 50_000, "full_payment");
      await pay(second, "2026-02-10", 10_000, "down_payment");
      await pay(second, "2026-03-10", 40_000, "full_payment");

      const response = await issue([second, first]);
      assert.equal(response.statusCode, 200);
      const { constancia } = response.json();

      assert.deepEqual(
        constancia.parts.map((part: { contract: { id: string } }) => part.contract.id),
        [first, second],
        "in lot order, whatever order they were asked in",
      );
      assert.equal(constancia.salePriceCents, lempiras(100_000));
      assert.equal(constancia.totalPaidCents, lempiras(100_000));
      assert.equal(constancia.lastPaidOn, "2026-03-10");
      assert.equal(constancia.parts[1].payments.length, 2);

      const again = (await issue([first, second])).json().constancia;
      assert.equal(again.id, constancia.id, "the same set hands back the same constancia");
    });

    it("lives beside each lot's own constancia, and is voided whole when one lot reopens", async () => {
      const first = await newContract();
      const second = await newContract();
      const firstReceipt = await pay(first, "2026-01-10", 50_000, "full_payment");
      await pay(second, "2026-01-10", 50_000, "full_payment");

      const own = (await issue(first)).json().constancia;
      const othersOwn = (await issue(second)).json().constancia;
      const combined = (await issue([first, second])).json().constancia;

      assert.notEqual(combined.id, own.id);
      assert.deepEqual(new Set((await standing(first)).map((c) => c.id)), new Set([own.id, combined.id]));

      await post(`/api/receipts/${firstReceipt.id}/void`, { reason: "Cheque rebotado" });

      const reread = async (id: string) => (await get(`/api/constancias/${id}`)).json().constancia;
      const voided = await reread(combined.id);

      assert.notEqual((await reread(own.id)).voidedAt, null);
      assert.notEqual(voided.voidedAt, null);
      assert.match(voided.voidReason, /contrato CT-/, "says which lot reopened it");
      assert.equal((await reread(othersOwn.id)).voidedAt, null, "the other lot's own still stands");
    });

    it("lists what can go on one: the customer's paid-off contracts only", async () => {
      const paid = await newContract();
      const owing = await newContract();
      await pay(paid, "2026-01-10", 50_000, "full_payment");
      await pay(owing, "2026-01-10", 10_000, "down_payment");

      const { eligible } = (await get(`/api/contracts/${paid}/constancias`)).json();
      const ids = eligible.map((row: { contractId: string }) => row.contractId);

      assert.ok(ids.includes(paid));
      assert.ok(!ids.includes(owing));
      assert.equal((await issue([paid, owing])).json().error, "not_paid_off");
    });

    it("is one customer's: lots of two customers cannot share one", async () => {
      const mine = await newContract();
      await pay(mine, "2026-01-10", 50_000, "full_payment");

      const otherCustomer = randomUUID();
      db.insert(customers)
        .values({ id: otherCustomer, fullName: "Otra Clienta", phone: "+50499990002", customerSince: "2026-01-01" })
        .run();
      lotNumber += 1;
      const lotId = randomUUID();
      db.insert(lots)
        .values({ id: lotId, projectId: ids.projectId, code: `CT-${lotNumber}`, areaM2: 300, basePriceCents: lempiras(20_000) })
        .run();
      const theirs = (
        await post("/api/contracts", {
          customerId: otherCustomer,
          lotId,
          kind: "contract",
          saleType: "cash",
          salePriceCents: lempiras(20_000),
          downPaymentCents: 0,
          signedOn: "2026-01-10",
        })
      ).json().contract.id;
      await post("/api/receipts", {
        customerId: otherCustomer,
        paidOn: "2026-01-10",
        method: "cash",
        lines: [{ contractId: theirs, amountCents: lempiras(20_000), type: "full_payment" }],
      });

      const response = await issue([mine, theirs]);
      assert.equal(response.statusCode, 409);
      assert.equal(response.json().error, "different_customers");
    });
  });
});
