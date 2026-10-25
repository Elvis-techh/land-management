import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

const lempiras = (amount: number) => Math.round(amount * 100);

/**
 * «Pagado por»: somebody other than the customer hands over the money, and
 * wants the receipt in their own name.
 *
 * These pin the promise behind it: the receipt names the payer, and nothing
 * else moves. The money still counts towards the customer's contract, a later
 * correction is filed with its reason, and the payment form can offer the
 * last payer instead of having the name typed again every month.
 */
describe("«Pagado por» on a receipt", async () => {
  const { app, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

  const issue = async (paidBy?: string | null, cookie = ownerCookie) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie },
      payload: {
        customerId: ids.customerId,
        paidOn: "2026-03-15",
        method: "cash",
        ...(paidBy === undefined ? {} : { paidBy }),
        lines: [{ contractId: ids.contractId, amountCents: lempiras(1_000), type: "installment" }],
      },
    });

    assert.equal(response.statusCode, 201, response.body);

    return response.json().receipt as {
      id: string;
      code: string;
      paidBy: string | null;
      customer: { id: string };
      lines: Array<{ contractId: string; amount: number }>;
    };
  };

  const lastPayer = async (cookie = ownerCookie) => {
    const response = await app.inject({
      method: "GET",
      url: `/api/receipts/last-payer?customerId=${ids.customerId}`,
      headers: { cookie },
    });

    assert.equal(response.statusCode, 200, response.body);

    return response.json().paidBy as string | null;
  };

  const setPaidBy = (cookie: string, receiptId: string, paidBy: string | null, reason: string) =>
    app.inject({
      method: "PATCH",
      url: `/api/receipts/${receiptId}/paid-by`,
      headers: { cookie },
      payload: { paidBy, reason },
    });

  it("names the payer, while the money stays on the customer's contract", async () => {
    const receipt = await issue("  Carlos Mejía  ");

    assert.equal(receipt.paidBy, "Carlos Mejía");
    assert.equal(receipt.customer.id, ids.customerId);
    assert.equal(receipt.lines[0]!.contractId, ids.contractId);

    const fetched = await app.inject({
      method: "GET",
      url: `/api/receipts/${receipt.id}`,
      headers: { cookie: staffCookie },
    });

    assert.equal(fetched.json().receipt.paidBy, "Carlos Mejía");
  });

  it("is null when the customer paid, whether the field was left out or left blank", async () => {
    assert.equal((await issue()).paidBy, null);
    assert.equal((await issue("   ")).paidBy, null);
    assert.equal((await issue(null)).paidBy, null);
  });

  it("offers the payer of the customer's latest receipt, and stops once the customer pays", async () => {
    await issue("Carlos Mejía", staffCookie);

    assert.equal(await lastPayer(staffCookie), "Carlos Mejía");

    await issue();

    assert.equal(await lastPayer(), null);
  });

  it("skips a voided receipt when offering the last payer", async () => {
    await issue("Carlos Mejía");
    const wrong = await issue("Pedro Equivocado");

    const voided = await app.inject({
      method: "POST",
      url: `/api/receipts/${wrong.id}/void`,
      headers: { cookie: ownerCookie },
      payload: { reason: "Se registró dos veces por error." },
    });

    assert.equal(voided.statusCode, 200, voided.body);
    assert.equal(await lastPayer(), "Carlos Mejía");
  });

  it("can be corrected afterwards, with a reason, and the correction is in the Historial", async () => {
    const receipt = await issue();

    const response = await setPaidBy(
      ownerCookie,
      receipt.id,
      "Carlos Mejía",
      "Él paga el lote de Juana y pidió el recibo a su nombre.",
    );

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().receipt.paidBy, "Carlos Mejía");
    assert.equal(response.json().receipt.customer.id, ids.customerId);

    const audit = (
      await app.inject({ method: "GET", url: "/api/audit", headers: { cookie: ownerCookie } })
    ).json();
    const entry = (
      audit.events as Array<{ entityId: string; action: string; reason: string | null; before: unknown; after: unknown }>
    ).find((event) => event.entityId === receipt.id && event.action === "update");

    assert.ok(entry, "the correction is filed");
    assert.equal(entry.reason, "Él paga el lote de Juana y pidió el recibo a su nombre.");
    assert.deepEqual(entry.before, { receiptCode: receipt.code, paidBy: null });
    assert.deepEqual(entry.after, { receiptCode: receipt.code, paidBy: "Carlos Mejía" });

    // And back to the customer's own name, by clearing it.
    const cleared = await setPaidBy(ownerCookie, receipt.id, "", "Se puso por error en este recibo.");

    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(cleared.json().receipt.paidBy, null);
  });

  it("refuses a correction without a real reason, or one that changes nothing", async () => {
    const receipt = await issue("Carlos Mejía");

    assert.equal((await setPaidBy(ownerCookie, receipt.id, "Otro", "corto")).statusCode, 400);
    assert.equal(
      (await setPaidBy(ownerCookie, receipt.id, "Carlos Mejía", "El mismo nombre otra vez.")).statusCode,
      409,
    );
  });

  it("refuses a correction to a voided receipt", async () => {
    const receipt = await issue();

    await app.inject({
      method: "POST",
      url: `/api/receipts/${receipt.id}/void`,
      headers: { cookie: ownerCookie },
      payload: { reason: "Se registró dos veces por error." },
    });

    const response = await setPaidBy(ownerCookie, receipt.id, "Carlos Mejía", "Lo pidió el que pagó.");

    assert.equal(response.statusCode, 409);
  });

  it("is corrected only by whoever may correct a payment", async () => {
    const receipt = await issue();

    // Staff record payments, so they can name a payer while issuing...
    assert.equal((await issue("Carlos Mejía", staffCookie)).paidBy, "Carlos Mejía");

    // ...but changing a receipt already issued is a correction, on `payment:edit`.
    const response = await setPaidBy(staffCookie, receipt.id, "Carlos Mejía", "Lo pidió el que pagó.");

    assert.equal(response.statusCode, 403);
  });
});
