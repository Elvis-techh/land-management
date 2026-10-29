import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { contracts } from "../src/db/schema.js";
import { shiftDays } from "../src/lib/contracts.js";
import { businessToday } from "../src/lib/time.js";
import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

/*
 * «Perdonar» through the routes.
 *
 * The fixture contract becomes a financed sale, as in mora-manual.test.ts:
 * L 135,000 with a L 15,000 prima (which the fixture's two payments cover
 * exactly) and cuotas of L 10,000, cuota 1 due 40 days ago and unpaid. L 500
 * of mora is put on cuota 1 today with «Cargar mora», so there is something
 * charged and unpaid to forgive with mora never switched on.
 */

const TODAY = businessToday("America/Tegucigalpa");
const FIRST_DUE = shiftDays(TODAY, -40);
const PRICE_LEFT = 12_000_000;

describe("«Perdonar»", async () => {
  const { app, sqlite, db, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  db.update(contracts)
    .set({
      kind: "contract",
      saleType: "financed",
      salePriceCents: 13_500_000,
      downPaymentCents: 1_500_000,
      termMonths: 12,
      monthlyPaymentCents: 1_000_000,
      dueDay: Number(FIRST_DUE.slice(8, 10)),
      signedOn: shiftDays(TODAY, -100),
      firstDueOn: FIRST_DUE,
    })
    .where(eq(contracts.id, ids.contractId))
    .run();

  const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

  const charged = await app.inject({
    method: "POST",
    url: `/api/contracts/${ids.contractId}/mora`,
    headers: { cookie },
    payload: { installment: 1, incurredOn: TODAY, amountCents: 50_000, reason: "Acordado con el cliente hoy." },
  });
  assert.equal(charged.statusCode, 201, charged.body);

  const contract = async () =>
    (await app.inject({ method: "GET", url: "/api/contracts", headers: { cookie } }))
      .json()
      .contracts.find((row: { id: string }) => row.id === ids.contractId);

  const moraOf = async () =>
    (await app.inject({ method: "GET", url: `/api/contracts/${ids.contractId}/mora`, headers: { cookie } })).json();

  const forgive = (payload: Record<string, unknown>, who = cookie) =>
    app.inject({
      method: "POST",
      url: `/api/contracts/${ids.contractId}/mora/forgive`,
      headers: { cookie: who },
      payload: {
        installment: 1,
        amountCents: 20_000,
        reason: "El cliente se puso al día; se le perdona parte.",
        ...payload,
      },
    });

  const pay = (amountCents: number) =>
    app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie },
      payload: {
        customerId: ids.customerId,
        paidOn: TODAY,
        method: "cash",
        lines: [{ contractId: ids.contractId, amountCents, type: "installment" }],
      },
    });

  const receipt = async (id: string) =>
    (await app.inject({ method: "GET", url: `/api/receipts/${id}`, headers: { cookie } })).json().receipt;

  const auditActions = async () =>
    (await app.inject({ method: "GET", url: "/api/audit", headers: { cookie } }))
      .json()
      .events.filter((event: { entityId: string }) => event.entityId === ids.contractId)
      .map((event: { action: string }) => event.action);

  it("offers what is unpaid of each cuota's mora", async () => {
    const mora = await moraOf();

    assert.deepEqual(mora.pendingByInstallment, { 1: 50_000 });
    assert.deepEqual(mora.forgiven, []);
  });

  it("refuses more than is unpaid, a cuota with no mora, a short reason and an associate", async () => {
    assert.equal((await forgive({ amountCents: 50_001 })).statusCode, 400);
    assert.equal((await forgive({ installment: 2 })).statusCode, 400);
    assert.equal((await forgive({ reason: "corto" })).statusCode, 400);
    assert.equal((await forgive({ amountCents: 0 })).statusCode, 400);
    assert.equal((await forgive({}, staffCookie)).statusCode, 403);
  });

  let earlierReceipt = "";
  let earlierFigures: Record<string, unknown> = {};

  it("leaves a receipt issued earlier the same day as it was", async () => {
    // L 100 today: «La mora» first, so it pays L 100 of the L 500.
    const response = await pay(10_000);
    assert.equal(response.statusCode, 201, response.body);
    earlierReceipt = response.json().receipt.id;

    const before = await receipt(earlierReceipt);
    earlierFigures = {
      previousBalance: before.previousBalance,
      newBalance: before.newBalance,
      moraCharged: before.moraCharged,
      moraPaid: before.lines[0].moraPaid,
    };
    assert.equal(before.newBalance, PRICE_LEFT + 40_000);

    const forgiven = await forgive({});
    assert.equal(forgiven.statusCode, 201, forgiven.body);

    const after = await receipt(earlierReceipt);
    assert.deepEqual(
      {
        previousBalance: after.previousBalance,
        newBalance: after.newBalance,
        moraCharged: after.moraCharged,
        moraPaid: after.lines[0].moraPaid,
      },
      earlierFigures,
    );
  });

  it("takes what was forgiven off the saldo and «Mora pendiente», and files it", async () => {
    const row = await contract();

    assert.deepEqual(row.mora, { charged: 50_000, paid: 10_000, forgiven: 20_000, pending: 20_000 });
    assert.equal(row.balance, PRICE_LEFT + 20_000);

    const mora = await moraOf();
    assert.deepEqual(mora.pendingByInstallment, { 1: 20_000 });
    assert.equal(mora.forgiven.length, 1);
    assert.equal(mora.forgiven[0].amountCents, 20_000);
    assert.equal(mora.forgiven[0].clearedCents, 20_000);
    assert.equal(mora.forgiven[0].forgivenOn, TODAY);

    const dashboard = (await app.inject({ method: "GET", url: "/api/dashboard", headers: { cookie } })).json();
    assert.equal(dashboard.income.mora.pendingCents, 20_000);

    assert.ok((await auditActions()).includes("mora_forgive"));
  });

  it("counts from then on: the next payment that day pays only what is left", async () => {
    const response = await pay(30_000);
    assert.equal(response.statusCode, 201, response.body);
    const later = await receipt(response.json().receipt.id);

    assert.deepEqual(later.lines[0].moraPaid, [{ installment: 1, amount: 20_000 }]);
    assert.equal(later.previousBalance, PRICE_LEFT + 20_000);
    assert.equal(later.newBalance, PRICE_LEFT + 20_000 - 30_000);
    // Valor + mora − total pagado = nuevo balance, on the page: the mora printed
    // is what was charged less what was forgiven.
    assert.equal(later.moraCharged, 30_000);

    assert.deepEqual((await moraOf()).pendingByInstallment, {});
    assert.equal((await forgive({ amountCents: 1 })).statusCode, 400);
  });

  it("is taken back with «Quitar», with a reason, and filed in the Historial", async () => {
    const entry = (await moraOf()).forgiven[0];
    const remove = (reason: string) =>
      app.inject({
        method: "POST",
        url: `/api/contracts/${ids.contractId}/mora/forgiven/${entry.id}/remove`,
        headers: { cookie },
        payload: { reason },
      });

    assert.equal((await remove("corto")).statusCode, 400);
    assert.equal((await remove("Se perdonó en el contrato equivocado.")).statusCode, 200);

    // The L 200 is owed again, and the later payment now pays it.
    const row = await contract();
    assert.equal(row.mora.forgiven, 0);
    assert.equal(row.mora.paid, 40_000);
    assert.equal(row.mora.pending, 10_000);
    assert.deepEqual((await moraOf()).forgiven, []);
    assert.ok((await auditActions()).includes("mora_unforgive"));

    assert.equal((await remove("Se perdonó en el contrato equivocado.")).statusCode, 404);
  });

  it("forgives all of what is left, and refuses a closed contract", async () => {
    const response = await forgive({ amountCents: 10_000 });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal((await contract()).mora.pending, 0);

    db.update(contracts).set({ status: "cancelled" }).where(eq(contracts.id, ids.contractId)).run();
    assert.equal((await forgive({ amountCents: 1 })).statusCode, 409);
    db.update(contracts).set({ status: "active" }).where(eq(contracts.id, ids.contractId)).run();
  });
});
