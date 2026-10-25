import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { contracts } from "../src/db/schema.js";
import { shiftDays } from "../src/lib/contracts.js";
import { businessToday } from "../src/lib/time.js";
import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

/*
 * «Cargar mora» through the routes, with mora never switched on in
 * Configuración: the case it exists for.
 *
 * The fixture contract becomes a financed sale: L 135,000 with a L 15,000
 * prima (which the fixture's two payments cover exactly) and cuotas of
 * L 10,000, cuota 1 due 40 days ago. Cuota 1 was paid ten days late with
 * L 200 of mora on top, entered as one payment of L 10,200.
 */

const TODAY = businessToday("America/Tegucigalpa");
const FIRST_DUE = shiftDays(TODAY, -40);
const PAID_ON = shiftDays(FIRST_DUE, 10);

describe("«Cargar mora»", async () => {
  const built = await buildTestApp();
  const { app, sqlite, db, ids } = built;
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

  const issued = await app.inject({
    method: "POST",
    url: "/api/receipts",
    headers: { cookie },
    payload: {
      customerId: ids.customerId,
      paidOn: PAID_ON,
      method: "cash",
      lines: [{ contractId: ids.contractId, amountCents: 1_020_000, type: "installment" }],
    },
  });
  assert.equal(issued.statusCode, 201, issued.body);
  const receiptId = issued.json().receipt.id as string;

  const contract = async () =>
    (await app.inject({ method: "GET", url: "/api/contracts", headers: { cookie } }))
      .json()
      .contracts.find((row: { id: string }) => row.id === ids.contractId);

  const moraOf = async () =>
    (await app.inject({ method: "GET", url: `/api/contracts/${ids.contractId}/mora`, headers: { cookie } })).json();

  const charge = (payload: Record<string, unknown>, who = cookie) =>
    app.inject({
      method: "POST",
      url: `/api/contracts/${ids.contractId}/mora`,
      headers: { cookie: who },
      payload: {
        installment: 1,
        incurredOn: PAID_ON,
        amountCents: 20_000,
        reason: "Pagó L 200 de mora en efectivo con la cuota 1.",
        ...payload,
      },
    });

  const auditActions = async () =>
    (await app.inject({ method: "GET", url: "/api/audit", headers: { cookie } }))
      .json()
      .events.filter((event: { entityId: string }) => event.entityId === ids.contractId);

  it("starts with the extra L 200 counted towards the price", async () => {
    const row = await contract();

    assert.deepEqual(row.mora, { charged: 0, paid: 0, pending: 0 });
    assert.equal(row.balance, 12_000_000 - 1_020_000);
  });

  it("offers the cuotas already due, and nothing put on by hand yet", async () => {
    const mora = await moraOf();

    assert.equal(mora.chargeable, true);
    assert.deepEqual(mora.manual, []);
    // The prima (on the signing day), cuota 1 and cuota 2 (due ten days ago).
    // Cuota 3 is not due yet.
    assert.deepEqual(
      mora.due.map((entry: { installment: number }) => entry.installment),
      [0, 1, 2],
    );
  });

  it("refuses a date on or before the cuota fell due, or in the future", async () => {
    assert.equal((await charge({ incurredOn: FIRST_DUE })).statusCode, 400);
    assert.equal((await charge({ incurredOn: shiftDays(TODAY, 1) })).statusCode, 400);
  });

  it("refuses a cuota the contract does not have, and a short reason", async () => {
    assert.equal((await charge({ installment: 40 })).statusCode, 400);
    assert.equal((await charge({ reason: "corto" })).statusCode, 400);
    assert.equal((await charge({ amountCents: 0 })).statusCode, 400);
  });

  it("is refused to an associate by default", async () => {
    assert.equal((await charge({}, staffCookie)).statusCode, 403);
  });

  it("turns the extra L 200 into mora on cuota 1: the old receipt shows it, the saldo goes up", async () => {
    const response = await charge({});
    assert.equal(response.statusCode, 201, response.body);

    const row = await contract();

    assert.deepEqual(row.mora, { charged: 20_000, paid: 20_000, pending: 0 });
    assert.equal(row.balance, 12_000_000 - 1_000_000);

    const receipt = (
      await app.inject({ method: "GET", url: `/api/receipts/${receiptId}`, headers: { cookie } })
    ).json().receipt;

    assert.deepEqual(receipt.lines[0].moraPaid, [{ installment: 1, amount: 20_000 }]);
    assert.equal(receipt.totalPaid, 1_020_000);

    const mora = await moraOf();

    assert.equal(mora.manual.length, 1);
    assert.equal(mora.manual[0].amountCents, 20_000);
    assert.equal(mora.manual[0].pendingCents, 0);
    assert.equal(mora.manual[0].reason, "Pagó L 200 de mora en efectivo con la cuota 1.");

    const filed = (await auditActions()).find((event: { action: string }) => event.action === "mora_charge");

    assert.ok(filed, "the charge is in the Historial");
    assert.equal(filed.reason, "Pagó L 200 de mora en efectivo con la cuota 1.");
    assert.deepEqual(filed.after, { moraInstallment: 1, moraIncurredOn: PAID_ON, amountCents: 20_000 });
  });

  it("is owed when nothing has paid it, and shows on the Panel", async () => {
    const response = await charge({ incurredOn: TODAY, amountCents: 50_000, reason: "Acordado con el cliente hoy." });
    assert.equal(response.statusCode, 201, response.body);

    const row = await contract();

    assert.equal(row.mora.pending, 50_000);
    assert.equal(row.balance, 11_000_000 + 50_000);

    const dashboard = (await app.inject({ method: "GET", url: "/api/dashboard", headers: { cookie } })).json();

    assert.equal(dashboard.income.mora.pendingCents, 50_000);
  });

  it("is taken back with «Quitar», with a reason, and filed in the Historial", async () => {
    const pending = (await moraOf()).manual.find((entry: { amountCents: number }) => entry.amountCents === 50_000);
    const remove = (reason: string) =>
      app.inject({
        method: "POST",
        url: `/api/contracts/${ids.contractId}/mora/${pending.id}/remove`,
        headers: { cookie },
        payload: { reason },
      });

    assert.equal((await remove("corto")).statusCode, 400);

    const response = await remove("Se cargó en el contrato equivocado.");
    assert.equal(response.statusCode, 200, response.body);

    assert.equal((await contract()).mora.pending, 0);
    assert.equal((await moraOf()).manual.length, 1);
    assert.ok((await auditActions()).some((event: { action: string }) => event.action === "mora_remove"));

    // Already taken back.
    assert.equal((await remove("Se cargó en el contrato equivocado.")).statusCode, 404);
  });

  it("refuses a closed contract", async () => {
    db.update(contracts).set({ status: "cancelled" }).where(eq(contracts.id, ids.contractId)).run();

    const response = await charge({});

    assert.equal(response.statusCode, 409);
    assert.equal((await moraOf()).chargeable, false);

    db.update(contracts).set({ status: "active" }).where(eq(contracts.id, ids.contractId)).run();
  });
});
