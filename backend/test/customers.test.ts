import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { and, eq, isNull, like } from "drizzle-orm";

import { auditEvents, customers } from "../src/db/schema.js";
import { normalizePhone } from "../src/lib/phone.js";
import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

describe("phone normalisation", () => {
  it("stores a Honduran number with its country code, however it was typed", () => {
    for (const typed of ["9982-4471", "9982 4471", "99824471", "+504 9982-4471", "50499824471"]) {
      assert.equal(normalizePhone(typed), "+50499824471", `failed on ${typed}`);
    }
  });

  it("keeps a foreign number as the international number it is", () => {
    // Eight digits get +504 added; an explicit "+" says the code is already
    // there. Adding +504 to a Miami number would send the receipt to a stranger.
    assert.equal(normalizePhone("+1 305 555 0123"), "+13055550123");
  });

  it("refuses what is not a phone number rather than guessing", () => {
    for (const junk of ["", "   ", "casa", "123", "+1", "9982-44710000000000000"]) {
      assert.equal(normalizePhone(junk), null, `should have refused ${junk}`);
    }
  });
});

describe("customers", async () => {
  const { app, db, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

  const list = async (cookie: string) =>
    app.inject({ method: "GET", url: "/api/customers", headers: { cookie } });

  const create = async (cookie: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/customers", headers: { cookie }, payload });

  const validCustomer = {
    fullName: "Nueva Clienta",
    identification: "0801-1991-55555",
    phone: "9800-1122",
    email: "nueva@correo.hn",
    address: "Col. Nueva, Tegucigalpa",
    customerSince: 2026,
    notes: "Pregunta por lotes de esquina.",
  };

  it("refuses to list customers without a session", async () => {
    const response = await app.inject({ method: "GET", url: "/api/customers" });
    assert.equal(response.statusCode, 401);
  });

  it("lets any signed-in user read the list", async () => {
    for (const cookie of [ownerCookie, staffCookie]) {
      const response = await list(cookie);
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().customers.length, 1);
    }
  });

  it("derives each customer's contracts instead of storing a count", async () => {
    const [customer] = (await list(ownerCookie)).json().customers;

    assert.equal(customer.contracts.length, 1);
    assert.equal(customer.contracts[0].contractCode, "CT-TEST-001");
    assert.equal(customer.contracts[0].lotCode, "A-01");
    assert.equal(customer.contracts[0].projectName, "Proyecto Prueba");
    // Summed from the payments table, exactly as the lots list does it.
    assert.equal(customer.contracts[0].paidToDate, 1_500_000);
    assert.equal(customer.contracts[0].salePrice, 18_500_000);
  });

  it("lets staff add a customer — day-to-day work, not history", async () => {
    const response = await create(staffCookie, validCustomer);
    assert.equal(response.statusCode, 201);

    // And the number was stored dialable, not as the user typed it.
    const row = db
      .select()
      .from(customers)
      .where(eq(customers.identification, validCustomer.identification))
      .get();

    assert.equal(row?.phone, "+50498001122");
    assert.equal(row?.notes, "Pregunta por lotes de esquina.");
  });

  it("refuses an identity number already on file, naming who holds it", async () => {
    const response = await create(ownerCookie, {
      ...validCustomer,
      fullName: "Otra Persona",
      identification: "0801-1990-00001",
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "duplicate_identification");

    // A duplicated customer splits their contracts across two records, so the
    // refusal has to name the person already using the number.
    const { message } = response.json();
    assert.match(message, /Cliente Prueba/);
    assert.doesNotMatch(message, /UNIQUE|constraint|identification_unique/i);
  });

  it("refuses a phone number it cannot dial", async () => {
    const response = await create(ownerCookie, {
      ...validCustomer,
      identification: "0801-1991-66666",
      phone: "no tiene",
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "invalid_phone");
  });

  it("accepts a customer with no email, address or notes", async () => {
    const response = await create(ownerCookie, {
      fullName: "Sin Correo",
      identification: "0801-1991-77777",
      phone: "9700-0001",
      customerSince: 2026,
    });

    assert.equal(response.statusCode, 201);
  });

  it("accepts a customer who has not given an identidad", async () => {
    // The number is confidential and often simply not available when somebody
    // is first written down. Refusing the customer does not produce the number.
    const response = await create(ownerCookie, {
      fullName: "Sin Identidad",
      phone: "9700-0002",
      customerSince: 2026,
    });

    assert.equal(response.statusCode, 201);

    const row = db
      .select()
      .from(customers)
      .where(eq(customers.fullName, "Sin Identidad"))
      .get();

    // NULL, not "". An empty string collides in the unique index with the next
    // customer who also has no identidad.
    assert.equal(row?.identification, null);
  });

  it("stores a blank identidad as an absence rather than as an empty string", async () => {
    // Every shape of "nothing" a form or an import can send.
    const blanks = [
      ["Blanco vacío", ""],
      ["Blanco espacios", "   "],
      ["Blanco nulo", null],
    ] as const;

    for (const [fullName, identification] of blanks) {
      const response = await create(ownerCookie, {
        fullName,
        identification,
        phone: "9700-0003",
        customerSince: 2026,
      });

      assert.equal(response.statusCode, 201, `failed on ${JSON.stringify(identification)}`);
    }

    const rows = db
      .select()
      .from(customers)
      .where(and(isNull(customers.identification), like(customers.fullName, "Blanco %")))
      .all();

    // Three customers, none of them a duplicate of the others. This is the case
    // the old NOT NULL column could not express at all.
    assert.equal(rows.length, 3);
  });

  it("still refuses a duplicate once an identidad IS given", async () => {
    // Optional does not mean unchecked: a real number entered twice still
    // splits somebody's contracts across two records.
    const response = await create(ownerCookie, {
      ...validCustomer,
      fullName: "Otra Persona",
      identification: "0801-1990-00001",
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "duplicate_identification");
  });

  it("lets a customer's identidad be removed again after it was entered", async () => {
    const created = await create(ownerCookie, {
      fullName: "Se Arrepintió",
      identification: "0801-1991-99999",
      phone: "9700-0004",
      customerSince: 2026,
    });

    assert.equal(created.statusCode, 201);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/customers/${created.json().customer.id}`,
      headers: { cookie: ownerCookie },
      payload: {
        fullName: "Se Arrepintió",
        identification: "",
        phone: "9700-0004",
        customerSince: 2026,
      },
    });

    assert.equal(response.statusCode, 200);

    const row = db
      .select()
      .from(customers)
      .where(eq(customers.id, created.json().customer.id))
      .get();

    assert.equal(row?.identification, null);
  });

  describe("deleting", () => {
    const remove = async (cookie: string, id: string, payload: Record<string, unknown>) =>
      app.inject({ method: "DELETE", url: `/api/customers/${id}`, headers: { cookie }, payload });

    /** A customer nobody has ever put on a contract — the only deletable kind. */
    const createDeletable = async (identification: string) => {
      const response = await create(ownerCookie, {
        ...validCustomer,
        fullName: "Cliente Sin Contratos",
        identification,
      });

      assert.equal(response.statusCode, 201);
      return response.json().customer.id as string;
    };

    it("refuses to delete a customer who is holding a lot right now", async () => {
      const response = await remove(ownerCookie, ids.customerId, {
        reason: "Se registró dos veces por error.",
      });

      assert.equal(response.statusCode, 409);
      assert.equal(response.json().error, "customer_has_active_contracts");
      // The refusal has to name the contract, or the user has no way to know
      // what they are supposed to cancel first.
      assert.match(response.json().message, /CT-TEST-001/);

      const row = db.select().from(customers).where(eq(customers.id, ids.customerId)).get();
      assert.ok(row, "the customer must still be on file");
    });

    it("asks for a motive before deleting", async () => {
      const id = await createDeletable("0801-1992-11111");
      const response = await remove(ownerCookie, id, { reason: "no" });

      assert.equal(response.statusCode, 400);
      assert.ok(db.select().from(customers).where(eq(customers.id, id)).get());
    });

    it("deletes a customer with no contracts and leaves the reason in the history", async () => {
      const id = await createDeletable("0801-1992-22222");
      const response = await remove(ownerCookie, id, {
        reason: "Capturado dos veces el 12 de agosto.",
      });

      assert.equal(response.statusCode, 200);
      assert.equal(db.select().from(customers).where(eq(customers.id, id)).get(), undefined);

      const event = db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.entityId, id))
        .all()
        .find((entry) => entry.action === "delete");

      assert.ok(event, "a deletion must be audited");
      assert.equal(event.reason, "Capturado dos veces el 12 de agosto.");
      // The whole record goes into the snapshot: there is nowhere else left to
      // read it from once the row is gone.
      assert.equal(JSON.parse(event.beforeJson!).fullName, "Cliente Sin Contratos");
      assert.equal(JSON.parse(event.beforeJson!).identification, "0801-1992-22222");
    });

    it("still names a deleted customer in the history rather than a UUID", async () => {
      const id = await createDeletable("0801-1992-33333");
      await remove(ownerCookie, id, { reason: "Duplicado del mismo cliente." });

      const events = (
        await app.inject({ method: "GET", url: "/api/audit", headers: { cookie: ownerCookie } })
      ).json().events;

      const removal = events.find(
        (event: { action: string; entityId: string }) =>
          event.action === "delete" && event.entityId === id,
      );

      assert.ok(removal);
      // Nothing is left to join to, so the label comes from the snapshot.
      assert.equal(removal.entityLabel, "Cliente Sin Contratos");
    });

    it("does not let an associate delete anybody by default", async () => {
      const id = await createDeletable("0801-1992-44444");
      const response = await remove(staffCookie, id, {
        reason: "Prueba de permisos del asociado.",
      });

      assert.equal(response.statusCode, 403);
      assert.ok(db.select().from(customers).where(eq(customers.id, id)).get());
    });

    it("returns 404 for a customer that does not exist", async () => {
      const response = await remove(ownerCookie, "00000000-0000-0000-0000-000000000000", {
        reason: "No debería existir este cliente.",
      });

      assert.equal(response.statusCode, 404);
    });
  });

  describe("editing", () => {
    it("updates a customer and files the change in the history", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/customers/${ids.customerId}`,
        headers: { cookie: ownerCookie },
        payload: {
          fullName: "Cliente Prueba",
          identification: "0801-1990-00001",
          phone: "9111-2222",
          email: null,
          address: null,
          customerSince: 2024,
          notes: "Cambió de número en agosto.",
        },
      });

      assert.equal(response.statusCode, 200);

      const row = db.select().from(customers).where(eq(customers.id, ids.customerId)).get();
      assert.equal(row?.phone, "+50491112222");
      assert.equal(row?.notes, "Cambió de número en agosto.");

      const event = db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.entityId, ids.customerId))
        .all()
        .find((entry) => entry.action === "update");

      assert.ok(event, "an update must be audited");
      assert.equal(JSON.parse(event.beforeJson!).phone, "+50499990000");
      assert.equal(JSON.parse(event.afterJson!).phone, "+50491112222");
    });

    it("does not mistake a customer for a duplicate of themselves", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/customers/${ids.customerId}`,
        headers: { cookie: ownerCookie },
        payload: {
          fullName: "Cliente Prueba",
          identification: "0801-1990-00001",
          phone: "9111-2222",
          customerSince: 2024,
        },
      });

      assert.equal(response.statusCode, 200);
    });

    it("returns 404 for a customer that does not exist", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/customers/00000000-0000-0000-0000-000000000000",
        headers: { cookie: ownerCookie },
        payload: { ...validCustomer, identification: "0801-1991-88888" },
      });

      assert.equal(response.statusCode, 404);
    });

    it("names the customer in the audit history rather than a UUID", async () => {
      const events = (
        await app.inject({ method: "GET", url: "/api/audit", headers: { cookie: ownerCookie } })
      ).json().events;

      const change = events.find(
        (event: { entityType: string; entityId: string }) =>
          event.entityType === "customer" && event.entityId === ids.customerId,
      );

      assert.ok(change);
      assert.equal(change.entityLabel, "Cliente Prueba");
    });

    // Last, because it takes a capability away from the associate and the
    // tests above expect them to still have it.
    it("refuses the edit as soon as the supervisor revokes customer:edit", async () => {
      const revoked = await app.inject({
        method: "PUT",
        url: "/api/permissions",
        headers: { cookie: ownerCookie },
        // The complete granted list, minus customer:edit — the route takes a
        // set, not a delta.
        payload: { capabilities: ["lot:create", "customer:create", "contract:create"] },
      });

      assert.equal(revoked.statusCode, 200);

      const response = await app.inject({
        method: "PATCH",
        url: `/api/customers/${ids.customerId}`,
        headers: { cookie: staffCookie },
        payload: {
          fullName: "Cliente Prueba",
          identification: "0801-1990-00001",
          phone: "9111-2222",
          customerSince: 2024,
        },
      });

      // Mid-session, on the very next request — no re-login involved.
      assert.equal(response.statusCode, 403);
    });
  });
});
