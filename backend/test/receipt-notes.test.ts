import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";

import { contracts } from "../src/db/schema.js";
import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

const lempiras = (amount: number) => Math.round(amount * 100);

/**
 * The note a clerk leaves on a receipt is a message to the rest of the office.
 *
 * It used to be printed at the foot of the document — which is also the image
 * sent to the customer over WhatsApp. These pin the new arrangement: the note
 * is stored, every user can read it, the people who record payments can change
 * it, and the change is on the record.
 */
describe("the internal note on a receipt", async () => {
  const { app, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

  const issue = async (note?: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie: ownerCookie },
      payload: {
        customerId: ids.customerId,
        paidOn: "2026-03-15",
        method: "cash",
        ...(note === undefined ? {} : { note }),
        lines: [{ contractId: ids.contractId, amountCents: lempiras(1_000), type: "installment" }],
      },
    });

    assert.equal(response.statusCode, 201, response.body);

    return response.json().receipt as { id: string; note: string | null };
  };

  const setNote = (cookie: string, receiptId: string, note: string | null) =>
    app.inject({
      method: "PATCH",
      url: `/api/receipts/${receiptId}/note`,
      headers: { cookie },
      payload: { note },
    });

  const transactionsOf = async (cookie: string, receiptId: string) => {
    const response = await app.inject({
      method: "GET",
      url: "/api/transactions",
      headers: { cookie },
    });

    return (
      response.json().transactions as Array<{ receiptId: string | null; receiptNote: string | null }>
    ).filter((row) => row.receiptId === receiptId);
  };

  it("is stored with the receipt and reaches every line of it", async () => {
    const receipt = await issue("Pagará el resto el viernes.");

    assert.equal(receipt.note, "Pagará el resto el viernes.");

    // The transactions list is what every screen reads. Staff, who may not even
    // edit a payment, must see the message on it.
    const rows = await transactionsOf(staffCookie, receipt.id);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.receiptNote, "Pagará el resto el viernes.");
  });

  it("is null, not an empty string, when nobody wrote one", async () => {
    const receipt = await issue();

    assert.equal(receipt.note, null);
    assert.equal((await transactionsOf(ownerCookie, receipt.id))[0]!.receiptNote, null);
  });

  it("can be written afterwards by whoever may record payments", async () => {
    const receipt = await issue();

    const response = await setNote(staffCookie, receipt.id, "  Falta el comprobante.  ");

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().receipt.note, "Falta el comprobante.");

    const fetched = await app.inject({
      method: "GET",
      url: `/api/receipts/${receipt.id}`,
      headers: { cookie: ownerCookie },
    });

    assert.equal(fetched.json().receipt.note, "Falta el comprobante.");
    assert.equal((await transactionsOf(ownerCookie, receipt.id))[0]!.receiptNote, "Falta el comprobante.");
  });

  it("is cleared by an empty note, however it is sent", async () => {
    const receipt = await issue("Borrar esto.");

    const blank = await setNote(ownerCookie, receipt.id, "   ");

    assert.equal(blank.statusCode, 200, blank.body);
    assert.equal(blank.json().receipt.note, null);

    await setNote(ownerCookie, receipt.id, "Otra vez.");

    const cleared = await setNote(ownerCookie, receipt.id, null);

    assert.equal(cleared.json().receipt.note, null);
  });

  it("is refused to anybody who may not record payments", async () => {
    const receipt = await issue("Original.");

    // Take the one capability the route is gated on away from staff.
    await app.inject({
      method: "PUT",
      url: "/api/permissions",
      headers: { cookie: ownerCookie },
      payload: { capabilities: ["customer:edit"] },
    });

    const response = await setNote(staffCookie, receipt.id, "Intento.");

    assert.equal(response.statusCode, 403);
    assert.equal((await transactionsOf(ownerCookie, receipt.id))[0]!.receiptNote, "Original.");

    // ...while READING it stays open to them, which is the whole point.
    assert.equal((await transactionsOf(staffCookie, receipt.id))[0]!.receiptNote, "Original.");

    await app.inject({
      method: "PUT",
      url: "/api/permissions",
      headers: { cookie: ownerCookie },
      payload: { capabilities: ["customer:edit", "payment:record"] },
    });
  });

  it("holds 500 characters and no more", async () => {
    const receipt = await issue();

    assert.equal((await setNote(ownerCookie, receipt.id, "x".repeat(500))).statusCode, 200);
    assert.equal((await setNote(ownerCookie, receipt.id, "x".repeat(501))).statusCode, 400);
  });

  it("says so for a receipt that does not exist", async () => {
    const response = await setNote(ownerCookie, "00000000-0000-0000-0000-000000000000", "Hola");

    assert.equal(response.statusCode, 404);
  });

  it("is allowed on a voided receipt, where the explanation belongs", async () => {
    const receipt = await issue("Antes de anular.");

    const voided = await app.inject({
      method: "POST",
      url: `/api/receipts/${receipt.id}/void`,
      headers: { cookie: ownerCookie },
      payload: { reason: "Se capturó en el cliente equivocado." },
    });

    assert.equal(voided.statusCode, 200, voided.body);

    const response = await setNote(ownerCookie, receipt.id, "Anulado: se rehízo con el cliente correcto.");

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().receipt.note, "Anulado: se rehízo con el cliente correcto.");
  });

  it("is not filed in the Historial, however often it is rewritten", async () => {
    const receipt = await issue("Primera versión.");

    const rewritten = await setNote(ownerCookie, receipt.id, "Segunda versión.");
    assert.equal(rewritten.json().receipt.note, "Segunda versión.");

    await setNote(ownerCookie, receipt.id, null);

    // A note is a message between colleagues, not a figure anything depends on.
    const events = (
      await app.inject({
        method: "GET",
        url: "/api/audit?limit=200",
        headers: { cookie: ownerCookie },
      })
    ).json().events as Array<{ entityId: string }>;

    assert.deepEqual(
      events.filter((event) => event.entityId === receipt.id),
      [],
    );
  });
});

/**
 * Correcting a transaction and writing the note in the same breath.
 *
 * The Nota field on the correction dialog used to be the payment's OWN note,
 * which nothing else on screen showed — so somebody typing in it never reached
 * the Nota del equipo box. It now writes the receipt's note, which is what
 * makes every line of one receipt read the same words.
 */
describe("the note written from the correction dialog", async () => {
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
    notes: string | null;
    receiptNote: string | null;
  };

  const rows = async (): Promise<Row[]> =>
    (
      await app.inject({ method: "GET", url: "/api/transactions", headers: { cookie: ownerCookie } })
    ).json().transactions;

  /** A receipt of two lots — one piece of paper, two payment rows. */
  const issueTwoLots = async (note?: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie: ownerCookie },
      payload: {
        customerId: ids.customerId,
        paidOn: "2026-03-15",
        method: "cash",
        ...(note === undefined ? {} : { note }),
        lines: [
          { contractId: ids.contractId, amountCents: lempiras(1_000), type: "installment" },
          { contractId: secondContractId, amountCents: lempiras(500), type: "installment" },
        ],
      },
    });

    assert.equal(response.statusCode, 201, response.body);

    const receiptId = response.json().receipt.id as string;
    const lines = (await rows()).filter((row) => row.receiptId === receiptId);

    assert.equal(lines.length, 2);

    return { receiptId, lines };
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

  const noteOf = async (rowId: string) => (await rows()).find((row) => row.id === rowId)!;

  it("reaches every line of the receipt, not only the one that was open", async () => {
    const { lines } = await issueTwoLots();

    const response = await correct(ownerCookie, lines[0]!, { receiptNote: "Pagan el resto el viernes." });

    assert.equal(response.statusCode, 200, response.body);

    for (const line of lines) {
      assert.equal((await noteOf(line.id)).receiptNote, "Pagan el resto el viernes.");
    }
  });

  it("clears the note when the box is emptied", async () => {
    const { lines } = await issueTwoLots("Se va a borrar.");

    const response = await correct(ownerCookie, lines[1]!, { receiptNote: "   " });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await noteOf(lines[0]!.id)).receiptNote, null);
    assert.equal((await noteOf(lines[1]!.id)).receiptNote, null);
  });

  it("leaves the note alone when the correction never mentions it", async () => {
    const { lines } = await issueTwoLots("Esto se queda.");

    // Only the date moves. `receiptNote` is absent, which is not the same as
    // blank: it must not erase what the team wrote.
    const response = await correct(ownerCookie, lines[0]!, { paidOn: "2026-03-14" });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await noteOf(lines[0]!.id)).receiptNote, "Esto se queda.");
    assert.equal((await noteOf(lines[1]!.id)).receiptNote, "Esto se queda.");
  });

  it("does not wipe a note the payment already carried on its own", async () => {
    const { lines } = await issueTwoLots();

    // How it used to be written: the payment's own note.
    await correct(ownerCookie, lines[0]!, { notes: "Nota vieja de esta transacción." });
    assert.equal((await noteOf(lines[0]!.id)).notes, "Nota vieja de esta transacción.");

    // The form no longer sends `notes` for a line with a receipt.
    const response = await correct(ownerCookie, lines[0]!, { receiptNote: "Nota nueva del equipo." });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await noteOf(lines[0]!.id)).notes, "Nota vieja de esta transacción.");
    assert.equal((await noteOf(lines[0]!.id)).receiptNote, "Nota nueva del equipo.");
  });

  it("is refused to somebody who may correct a payment but not record one", async () => {
    const { lines } = await issueTwoLots("Original.");

    await app.inject({
      method: "PUT",
      url: "/api/permissions",
      headers: { cookie: ownerCookie },
      payload: { capabilities: ["payment:edit"] },
    });

    const refused = await correct(staffCookie, lines[0]!, { receiptNote: "Intento." });

    assert.equal(refused.statusCode, 403);
    assert.equal((await noteOf(lines[0]!.id)).receiptNote, "Original.");

    // The same correction with the note sent back AS IT IS goes through: only a
    // note that changes needs the permission.
    const allowed = await correct(staffCookie, lines[0]!, {
      paidOn: "2026-03-14",
      receiptNote: "Original.",
    });

    assert.equal(allowed.statusCode, 200, allowed.body);

    await app.inject({
      method: "PUT",
      url: "/api/permissions",
      headers: { cookie: ownerCookie },
      payload: { capabilities: ["payment:edit", "payment:record"] },
    });
  });

  it("has no receipt to put a team note on for money recorded before receipts existed", async () => {
    const orphan = (await rows()).find((row) => row.receiptId === null)!;

    assert.ok(orphan, "the fixture has payments from before receipts");

    const refused = await correct(ownerCookie, orphan, { receiptNote: "No hay dónde." });

    assert.equal(refused.statusCode, 400);
    assert.equal(refused.json().error, "no_receipt");

    // Its own note still works, since there is nothing else to hold it.
    const own = await correct(ownerCookie, orphan, { notes: "Solo de este pago." });

    assert.equal(own.statusCode, 200, own.body);
    assert.equal((await noteOf(orphan.id)).notes, "Solo de este pago.");
  });

  it("files the correction in the Historial, but not the note that went with it", async () => {
    const { receiptId, lines } = await issueTwoLots("Antes.");

    const response = await correct(ownerCookie, lines[0]!, { receiptNote: "Después." });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await noteOf(lines[0]!.id)).receiptNote, "Después.");

    const events = (
      await app.inject({ method: "GET", url: "/api/audit?limit=200", headers: { cookie: ownerCookie } })
    ).json().events as Array<{ entityId: string; reason: string | null }>;

    // Nothing is filed against the receipt itself: that row was the note's.
    assert.deepEqual(
      events.filter((event) => event.entityId === receiptId),
      [],
    );

    // The correction is still there, under the line that was corrected, with
    // the reason — and neither version of the note is in it.
    const correction = events.find((event) => event.entityId === lines[0]!.id);

    assert.ok(correction, "the correction is filed under the line it changed");
    assert.equal(correction.reason, "Corrección de prueba sobre el recibo");
    assert.equal(JSON.stringify(events).includes("Antes."), false);
    assert.equal(JSON.stringify(events).includes("Después."), false);
  });
});
