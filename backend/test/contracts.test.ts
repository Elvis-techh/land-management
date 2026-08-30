import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { auditEvents, contracts, lots } from "../src/db/schema.js";
import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

const lempiras = (amount: number) => Math.round(amount * 100);

describe("contracts", async () => {
  const { app, db, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

  /** A free lot to sell, made directly so a test never runs out of inventory. */
  const freshLot = (code: string) => {
    const id = randomUUID();
    db.insert(lots)
      .values({ id, projectId: ids.projectId, code, areaM2: 300, basePriceCents: lempiras(100_000) })
      .run();
    return id;
  };

  const list = async (cookie: string) =>
    app.inject({ method: "GET", url: "/api/contracts", headers: { cookie } });

  const create = async (cookie: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/contracts", headers: { cookie }, payload });

  /** L 185,000, L 25,000 down, 24 months at L 6,700, due the 5th. */
  const financedSale = (lotId: string) => ({
    customerId: ids.customerId,
    lotId,
    kind: "contract" as const,
    saleType: "financed" as const,
    salePriceCents: lempiras(185_000),
    downPaymentCents: lempiras(25_000),
    termMonths: 24,
    monthlyPaymentCents: lempiras(6_700),
    dueDay: 5,
    signedOn: "2026-03-10",
  });

  it("refuses to list contracts without a session", async () => {
    const response = await app.inject({ method: "GET", url: "/api/contracts" });
    assert.equal(response.statusCode, 401);
  });

  it("derives what is owed instead of reading it from a column", async () => {
    const [contract] = (await list(ownerCookie)).json().contracts;

    assert.equal(contract.code, "CT-TEST-001");
    assert.equal(contract.lot.code, "A-01");
    assert.equal(contract.customer.fullName, "Cliente Prueba");
    // The seeded contract has two payments totalling L 15,000 against a price
    // of L 185,000. Both figures are computed on this request.
    assert.equal(contract.paidToDate, lempiras(15_000));
    assert.equal(contract.balance, lempiras(170_000));
    // And the prima is asked about separately: L 10,000 of that was a
    // down_payment, the rest an installment.
    assert.equal(contract.downPaymentPaid, lempiras(10_000));
  });

  it("creates a financed sale and assigns the contract number itself", async () => {
    const response = await create(ownerCookie, financedSale(freshLot("N-01")));

    assert.equal(response.statusCode, 201);
    // Sequential, per year, from the signing date — never sent by the client.
    assert.equal(response.json().contract.code, "CT-2026-001");

    const created = (await list(ownerCookie))
      .json()
      .contracts.find((row: { code: string }) => row.code === "CT-2026-001");

    assert.equal(created.terms.financed, lempiras(160_000));
    assert.equal(created.balance, lempiras(185_000));
    assert.equal(created.installmentCount, 24);
    assert.equal(created.terms.firstDueOn, "2026-04-05");
  });

  it("keeps numbering upwards", async () => {
    const response = await create(ownerCookie, financedSale(freshLot("N-02")));
    assert.equal(response.json().contract.code, "CT-2026-002");
  });

  it("refuses to sell a lot that already has a contract", async () => {
    const response = await create(ownerCookie, {
      ...financedSale(ids.heldLotId),
    });

    assert.equal(response.statusCode, 409);
    assert.match(response.json().message, /CT-TEST-001/);
  });

  it("refuses a credit sale with no plazo, cuota or día de pago", async () => {
    const { termMonths, monthlyPaymentCents, dueDay, ...incomplete } = financedSale(
      freshLot("N-03"),
    );

    const response = await create(ownerCookie, incomplete);

    assert.equal(response.statusCode, 400);
    assert.match(response.json().message, /plazo/i);
  });

  it("refuses a cash sale carrying a payment schedule", async () => {
    const response = await create(ownerCookie, {
      ...financedSale(freshLot("N-04")),
      saleType: "cash",
      downPaymentCents: 0,
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.json().message, /contado/i);
  });

  it("records a donation at zero and refuses one with a price", async () => {
    const withPrice = await create(ownerCookie, {
      ...financedSale(freshLot("N-05")),
      saleType: "donation",
      termMonths: null,
      monthlyPaymentCents: null,
      dueDay: null,
    });

    assert.equal(withPrice.statusCode, 400);
    assert.match(withPrice.json().message, /cero/i);

    const donated = await create(ownerCookie, {
      ...financedSale(freshLot("N-06")),
      saleType: "donation",
      salePriceCents: 0,
      downPaymentCents: 0,
      termMonths: null,
      monthlyPaymentCents: null,
      dueDay: null,
    });

    assert.equal(donated.statusCode, 201);

    // It sits in the table like any other contract, so the lot's history says
    // what became of it rather than the lot simply going quiet.
    const row = (await list(ownerCookie))
      .json()
      .contracts.find((entry: { code: string }) => entry.code === donated.json().contract.code);

    assert.equal(row.balance, 0);
    assert.equal(row.health.status, "current");
    assert.equal(row.health.settled, true);
  });

  it("refuses a reservation with no expiry date", async () => {
    const response = await create(ownerCookie, {
      ...financedSale(freshLot("N-07")),
      kind: "reservation",
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.json().message, /vencimiento/i);
  });

  it("refuses a prima larger than the price", async () => {
    const response = await create(ownerCookie, {
      ...financedSale(freshLot("N-08")),
      downPaymentCents: lempiras(200_000),
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.json().message, /prima/i);
  });

  it("refuses a date that is not a day", async () => {
    const response = await create(ownerCookie, {
      ...financedSale(freshLot("N-09")),
      signedOn: "2026-02-31",
    });

    assert.equal(response.statusCode, 400);
  });

  it("writes an audit row naming the terms that were agreed", async () => {
    const created = await create(ownerCookie, financedSale(freshLot("N-10")));
    const entry = db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, created.json().contract.id))
      .get();

    assert.equal(entry?.action, "create");
    assert.equal(entry?.entityType, "contract");
    assert.equal(JSON.parse(entry!.afterJson!).monthlyPaymentCents, lempiras(6_700));
  });
});

describe("a purchase of several lots", async () => {
  const { app, db, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

  const freshLot = (code: string) => {
    const id = randomUUID();
    db.insert(lots)
      .values({ id, projectId: ids.projectId, code, areaM2: 300, basePriceCents: lempiras(100_000) })
      .run();
    return id;
  };

  const sale = (lotId: string, joinGroupOfContractId?: string) => ({
    customerId: ids.customerId,
    lotId,
    kind: "contract" as const,
    saleType: "financed" as const,
    salePriceCents: lempiras(100_000),
    downPaymentCents: lempiras(10_000),
    termMonths: 24,
    monthlyPaymentCents: lempiras(3_750),
    dueDay: 5,
    signedOn: "2026-03-10",
    joinGroupOfContractId,
  });

  const create = async (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/contracts",
      headers: { cookie: ownerCookie },
      payload,
    });

  const first = await create(sale(freshLot("G-01")));
  const second = await create(sale(freshLot("G-02"), first.json().contract.id));
  const third = await create(sale(freshLot("G-03"), second.json().contract.id));

  it("groups the three contracts under one purchase", async () => {
    assert.equal(second.statusCode, 201);
    assert.equal(third.statusCode, 201);

    const groupId = second.json().contract.saleGroupId;
    assert.ok(groupId);

    // The first lot was signed before anybody knew a second was coming, so it
    // had no group. Joining stamps it retroactively rather than leaving one
    // contract of the purchase outside it.
    const stamped = db
      .select({ saleGroupId: contracts.saleGroupId })
      .from(contracts)
      .where(eq(contracts.id, first.json().contract.id))
      .get();

    assert.equal(stamped?.saleGroupId, groupId);
    assert.equal(third.json().contract.saleGroupId, groupId);
  });

  it("keeps each lot's balance its own", async () => {
    const rows = (await app.inject({
      method: "GET",
      url: "/api/contracts",
      headers: { cookie: ownerCookie },
    }))
      .json()
      .contracts.filter(
        (row: { saleGroupId: string | null }) =>
          row.saleGroupId === second.json().contract.saleGroupId,
      );

    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.balance, lempiras(100_000));
    }
  });

  it("splits one payment the way it is done by hand", async () => {
    const groupId = second.json().contract.saleGroupId;

    const response = await app.inject({
      method: "GET",
      url: `/api/contracts/groups/${groupId}/split?amountCents=${lempiras(25_000)}`,
      headers: { cookie: ownerCookie },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();

    assert.equal(body.unallocatedCents, 0);
    assert.deepEqual(
      body.lines.map((line: { amountCents: number }) => line.amountCents).sort((a: number, b: number) => a - b),
      [lempiras(8_300), lempiras(8_300), lempiras(8_400)],
    );
    // Every line says what the lot will owe afterwards, so the split can be
    // checked before any money is recorded.
    for (const line of body.lines) {
      assert.equal(line.balanceAfter, line.balanceBefore - line.amountCents);
    }
  });

  it("refuses to group lots belonging to different customers", async () => {
    const otherCustomer = randomUUID();
    db.run(
      `INSERT INTO customers (id, full_name, identification, phone, customer_since)
       VALUES ('${otherCustomer}', 'Otra Persona', '0801-1999-12345', '+50499990001', 2026)`,
    );

    const response = await create({
      ...sale(freshLot("G-04"), first.json().contract.id),
      customerId: otherCustomer,
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.json().message, /un solo cliente/i);
  });
});

describe("editing and cancelling", async () => {
  const { app, db, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

  const terms = {
    kind: "contract" as const,
    saleType: "financed" as const,
    salePriceCents: lempiras(185_000),
    downPaymentCents: lempiras(25_000),
    termMonths: 24,
    monthlyPaymentCents: lempiras(6_700),
    dueDay: 5,
    signedOn: "2026-03-10",
  };

  const patch = async (cookie: string, id: string, payload: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: `/api/contracts/${id}`, headers: { cookie }, payload });

  const cancel = async (cookie: string, id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/api/contracts/${id}/cancel`,
      headers: { cookie },
      payload,
    });

  it("does not let an associate edit signed terms by default", async () => {
    const response = await patch(staffCookie, ids.contractId, terms);
    assert.equal(response.statusCode, 403);
  });

  it("lets a supervisor correct the terms", async () => {
    const response = await patch(ownerCookie, ids.contractId, {
      ...terms,
      salePriceCents: lempiras(185_000),
      dueDay: 15,
      reason: "El contrato firmado dice día 15; se capturó día 5 por error.",
    });

    assert.equal(response.statusCode, 200);

    const row = db.select().from(contracts).where(eq(contracts.id, ids.contractId)).get();
    assert.equal(row?.dueDay, 15);
    assert.equal(row?.termMonths, 24);
  });

  it("demands a written motive for ANY edit, not only a reprice", async () => {
    // Same price, only the due day moves — and it is still refused. What was
    // signed does not change quietly.
    const response = await patch(ownerCookie, ids.contractId, { ...terms, dueDay: 20 });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "reason_required");

    const row = db.select().from(contracts).where(eq(contracts.id, ids.contractId)).get();
    assert.equal(row?.dueDay, 15, "the refused edit must not have landed");
  });

  it("lets an associate with contract:edit change terms but not the price", async () => {
    const grant = (capabilities: string[]) =>
      app.inject({
        method: "PUT",
        url: "/api/permissions",
        headers: { cookie: ownerCookie },
        payload: { capabilities },
      });

    // Editing is handed over; repricing deliberately is not.
    await grant(["contract:create", "contract:edit", "customer:create", "payment:record"]);

    const edit = await patch(staffCookie, ids.contractId, {
      ...terms,
      dueDay: 15,
      termMonths: 30,
      reason: "El cliente pidió alargar el plazo y el supervisor lo autorizó.",
    });
    assert.equal(edit.statusCode, 200);

    const reprice = await patch(staffCookie, ids.contractId, {
      ...terms,
      termMonths: 30,
      salePriceCents: lempiras(190_000),
      reason: "Intento de subir el precio sin el permiso correspondiente.",
    });
    assert.equal(reprice.statusCode, 403);

    // And with the second switch on, the same request goes through.
    await grant([
      "contract:create",
      "contract:edit",
      "contract:reprice",
      "customer:create",
      "payment:record",
    ]);

    const allowed = await patch(staffCookie, ids.contractId, {
      ...terms,
      termMonths: 30,
      salePriceCents: lempiras(190_000),
      reason: "Precio corregido contra la escritura, ya con el permiso concedido.",
    });
    assert.equal(allowed.statusCode, 200);

    const row = db.select().from(contracts).where(eq(contracts.id, ids.contractId)).get();
    assert.equal(row?.salePriceCents, lempiras(190_000));
  });

  it("refuses to price a contract below what has already been paid", async () => {
    // L 15,000 is already posted against this contract.
    const response = await patch(ownerCookie, ids.contractId, {
      ...terms,
      salePriceCents: lempiras(10_000),
      downPaymentCents: lempiras(1_000),
      reason: "Corrección del precio acordado en la escritura.",
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.json().message, /pagado/i);
  });

  it("demands a written motive before repricing a contract with payments on it", async () => {
    const response = await patch(ownerCookie, ids.contractId, {
      ...terms,
      salePriceCents: lempiras(200_000),
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "reason_required");
  });

  it("files an edit that leaves the price alone under `update`, not `reprice`", async () => {
    // Read the price back rather than restating it: earlier cases in this
    // block have already moved it, and what makes this an `update` is that the
    // price does not change — not that it happens to be any given figure.
    const before = db.select().from(contracts).where(eq(contracts.id, ids.contractId)).get();

    const response = await patch(ownerCookie, ids.contractId, {
      ...terms,
      salePriceCents: before!.salePriceCents,
      dueDay: 25,
      reason: "Se movió el día de cobro a fin de mes a pedido del cliente.",
    });

    assert.equal(response.statusCode, 200);

    const entries = db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, ids.contractId))
      .all();

    assert.ok(entries.some((entry) => entry.action === "update" && entry.reason !== null));
  });

  it("files a reprice under its own audit action", async () => {
    const response = await patch(ownerCookie, ids.contractId, {
      ...terms,
      salePriceCents: lempiras(200_000),
      reason: "Se renegoció el precio por el acceso al lote vecino.",
    });

    assert.equal(response.statusCode, 200);

    const entries = db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, ids.contractId))
      .all();

    assert.ok(entries.some((entry) => entry.action === "reprice"));
  });

  it("refuses to cancel without a motive", async () => {
    const response = await cancel(ownerCookie, ids.contractId, { reason: "no" });
    assert.equal(response.statusCode, 400);
  });

  it("does not let an associate cancel a contract by default", async () => {
    const response = await cancel(staffCookie, ids.contractId, {
      reason: "El cliente desistió de la compra.",
    });

    assert.equal(response.statusCode, 403);
  });

  it("cancels the contract and gives the lot back", async () => {
    const before = (await app.inject({
      method: "GET",
      url: "/api/lots",
      headers: { cookie: ownerCookie },
    }))
      .json()
      .lots.find((lot: { id: string }) => lot.id === ids.heldLotId);

    assert.ok(before.holding, "the lot should start out held");

    const response = await cancel(ownerCookie, ids.contractId, {
      reason: "El cliente desistió de la compra y se le devolvió la prima.",
    });

    assert.equal(response.statusCode, 200);

    const after = (await app.inject({
      method: "GET",
      url: "/api/lots",
      headers: { cookie: ownerCookie },
    }))
      .json()
      .lots.find((lot: { id: string }) => lot.id === ids.heldLotId);

    // Availability is derived from active contracts, so the lot came back on
    // its own — nothing wrote a status anywhere.
    assert.equal(after.holding, null);

    const row = db.select().from(contracts).where(eq(contracts.id, ids.contractId)).get();
    assert.equal(row?.status, "cancelled");
    assert.ok(row?.closedAt);
    assert.match(row!.closedReason!, /desistió/);
  });

  it("keeps the cancelled contract and its payments readable", async () => {
    const row = (await app.inject({
      method: "GET",
      url: "/api/contracts",
      headers: { cookie: ownerCookie },
    }))
      .json()
      .contracts.find((entry: { id: string }) => entry.id === ids.contractId);

    assert.equal(row.status, "cancelled");
    assert.equal(row.paidToDate, lempiras(15_000));
  });

  it("refuses to edit or cancel a contract that is already closed", async () => {
    const edited = await patch(ownerCookie, ids.contractId, terms);
    assert.equal(edited.statusCode, 409);

    const cancelled = await cancel(ownerCookie, ids.contractId, {
      reason: "Intento de cancelar dos veces el mismo contrato.",
    });
    assert.equal(cancelled.statusCode, 409);
  });
});
