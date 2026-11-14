import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { contracts, moraRules, payments } from "../src/db/schema.js";
import { shiftDays } from "../src/lib/contracts.js";
import type { MoraSettings } from "../src/lib/settings.js";
import { DEFAULT_SETTINGS, writeSection } from "../src/lib/settings.js";
import { businessToday } from "../src/lib/time.js";
import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

/*
 * The mora changed in «Registrar un pago», through the routes: the owner's
 * answers of 2026-11-06 (lib/moraAtPayment.ts).
 *
 * The fixture contract as in mora-charging.test.ts: L 135,000, a L 15,000
 * prima the fixture's payments cover, cuotas of L 10,000. Cuota 1 fell due 40
 * days ago and cuota 2 about ten days ago, both unpaid. Mora on since 60 days
 * ago at 2 %, once, 5 days of grace: L 200 on each, L 400 owed.
 */

const TODAY = businessToday("America/Tegucigalpa");
const FIRST_DUE = shiftDays(TODAY, -40);
const EACH = 20_000;
const OWED = 2 * EACH;
const CUOTA = 1_000_000;

const RULES: MoraSettings = {
  ...DEFAULT_SETTINGS.mora,
  enabled: true,
  startsOn: shiftDays(TODAY, -60),
  calculation: "percent",
  percent: 2,
  graceDays: 5,
  frequency: "once",
  paymentOrder: "mora",
};

const REASON = "Contrato migrado de Airtable, sin mora pactada.";

async function lateContract(rules: MoraSettings = RULES) {
  const built = await buildTestApp();
  const { app, db, ids } = built;

  db.update(contracts)
    .set({
      kind: "contract",
      saleType: "financed",
      salePriceCents: 13_500_000,
      downPaymentCents: 1_500_000,
      termMonths: 12,
      monthlyPaymentCents: CUOTA,
      dueDay: Number(FIRST_DUE.slice(8, 10)),
      signedOn: shiftDays(TODAY, -100),
      firstDueOn: FIRST_DUE,
    })
    .where(eq(contracts.id, ids.contractId))
    .run();

  writeSection(db, "mora", rules, ids.ownerId);
  db.insert(moraRules)
    .values({ id: randomUUID(), effectiveFrom: rules.startsOn!, value: JSON.stringify(rules), recordedBy: ids.ownerId })
    .run();

  const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

  const pay = (amountCents: number, mora?: unknown, extra: Record<string, unknown> = {}, who = cookie) =>
    app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie: who },
      payload: {
        customerId: ids.customerId,
        paidOn: TODAY,
        method: "cash",
        lines: [{ contractId: ids.contractId, amountCents, type: "installment", ...(mora ? { mora } : {}) }],
        ...extra,
      },
    });

  const get = async (url: string) => {
    const response = await app.inject({ method: "GET", url, headers: { cookie } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };

  const pending = async () =>
    (await get("/api/contracts")).contracts.find((row: { id: string }) => row.id === ids.contractId).mora.pending;

  const audit = async () =>
    (await get("/api/audit")).events.filter((event: { entityId: string }) => event.entityId === ids.contractId);

  return { ...built, cookie, staffCookie, pay, get, pending, audit, close: () => app.close() };
}

describe("mora in «Registrar un pago»", () => {
  it("says why each lot owes mora, and where «Cobrar mora» would go", async () => {
    const t = await lateContract();
    const { contracts: lots } = await t.get(`/api/customers/${t.ids.customerId}/payment-mora`);
    const lot = lots.find((row: { contractId: string }) => row.contractId === t.ids.contractId);

    assert.equal(lot.carriesMora, true);
    assert.equal(lot.pendingCents, OWED);
    assert.deepEqual(lot.late, { installment: 1, dueOn: FIRST_DUE });
    assert.equal(lot.charges.length, 2);
    assert.deepEqual(
      { ...lot.charges[0], rule: undefined },
      {
        installment: 1,
        dueOn: FIRST_DUE,
        incurredOn: shiftDays(FIRST_DUE, 6),
        amountCents: EACH,
        pendingCents: EACH,
        forgivenCents: 0,
        unpaidCents: CUOTA,
        manual: false,
        repeat: false,
        rule: undefined,
      },
    );
    assert.deepEqual(lot.charges[0].rule, {
      calculation: "percent",
      percent: 2,
      fixedCents: RULES.fixedCents,
      capCents: null,
      graceDays: 5,
    });
    await t.close();
  });

  it("explains a cuota whole, its paid and forgiven charges too, and leaves out one with nothing owed", async () => {
    // Every month: cuota 1 is charged twice (about 34 and 4 days ago), cuota 2 once.
    const t = await lateContract({ ...RULES, frequency: "monthly" });
    const charges = async () => {
      const { contracts: lots } = await t.get(`/api/customers/${t.ids.customerId}/payment-mora`);
      return lots.find((row: { contractId: string }) => row.contractId === t.ids.contractId).charges as Array<
        Record<string, unknown>
      >;
    };
    const forgive = (installment: number, amountCents: number) =>
      t.app.inject({
        method: "POST",
        url: `/api/contracts/${t.ids.contractId}/mora/forgive`,
        headers: { cookie: t.cookie },
        payload: { installment, amountCents, reason: REASON },
      });

    assert.equal((await charges()).length, 3);

    // «La mora primero»: L 200 pays cuota 1's first charge, the oldest.
    assert.equal((await t.pay(EACH)).statusCode, 201);
    // All of cuota 2's, and L 50 of cuota 1's second charge.
    assert.equal((await forgive(2, EACH)).statusCode, 201);
    assert.equal((await forgive(1, 5_000)).statusCode, 201);

    assert.deepEqual(
      (await charges()).map(({ installment, amountCents, pendingCents, forgivenCents, repeat }) => ({
        installment,
        amountCents,
        pendingCents,
        forgivenCents,
        repeat,
      })),
      [
        { installment: 1, amountCents: EACH, pendingCents: 0, forgivenCents: 0, repeat: false },
        { installment: 1, amountCents: EACH, pendingCents: 15_000, forgivenCents: 5_000, repeat: true },
      ],
    );
    await t.close();
  });

  it("previews the payment with the mora changed, and «Repartir» divides with it", async () => {
    const t = await lateContract();
    const url = `/api/contracts/${t.ids.contractId}/after-payment?amountCents=${CUOTA}`;

    assert.equal((await t.get(url)).mora, OWED);
    const none = await t.get(`${url}&moraCents=0`);
    assert.equal(none.mora, 0);
    assert.equal(none.moraPending, 0);
    assert.equal(none.appliedTo[0].settled, true);
    assert.equal((await t.get(`${url}&moraCents=60000`)).mora, 60_000);

    const split = `/api/customers/${t.ids.customerId}/split?amountCents=${CUOTA}`;
    const line = (body: { lines: Array<{ contractId: string; belowMinimum: boolean }> }) =>
      body.lines.find((entry) => entry.contractId === t.ids.contractId)!;
    // The cuota alone falls short of cuota + L 400 of mora, and not of cuota + no mora.
    assert.equal(line(await t.get(split)).belowMinimum, true);
    assert.equal(line(await t.get(`${split}&mora=${t.ids.contractId}:0`)).belowMinimum, false);
    await t.close();
  });

  it("previews a payment on its own date, as the save places it (owner, 10 Nov 2026)", async () => {
    const t = await lateContract();
    const url = `/api/contracts/${t.ids.contractId}/after-payment?amountCents=${CUOTA}`;
    const early = shiftDays(FIRST_DUE, -5);
    const priceLeft = 13_500_000 - 1_500_000 - CUOTA;

    // Today the L 400 of mora is paid first and L 9,600 reaches cuota 1.
    const today = await t.get(url);
    assert.equal(today.mora, OWED);
    assert.equal(today.moraPending, 0);
    assert.equal(today.newBalance, priceLeft + OWED);

    // Dated before cuota 1 fell due: no mora existed to pay, and cuota 1 is
    // paid on time, so its L 200 is never charged. Cuota 2's stays owed.
    const before = await t.get(`${url}&paidOn=${early}`);
    assert.equal(before.mora, 0);
    assert.equal(before.toDownPayment, 0);
    assert.equal(before.appliedTo[0].number, 1);
    assert.equal(before.appliedTo[0].settled, true);
    assert.equal(before.moraPending, EACH);
    assert.equal(before.newBalance, priceLeft + EACH);

    // A changed mora goes only with today's date, as on POST /receipts.
    const changed = await t.app.inject({
      method: "GET",
      url: `${url}&paidOn=${early}&moraCents=0`,
      headers: { cookie: t.cookie },
    });
    assert.equal(changed.statusCode, 400);
    assert.equal(changed.json().error, "mora_needs_today");

    // Saved with that date, the lot owes what the preview said.
    assert.equal((await t.pay(CUOTA, undefined, { paidOn: early })).statusCode, 201);
    const row = (await t.get("/api/contracts")).contracts.find((entry: { id: string }) => entry.id === t.ids.contractId);
    assert.equal(row.balance, before.newBalance);
    assert.equal(await t.pending(), EACH);
    await t.close();
  });

  it("says what a lot owed on a past date: the «Balance Anterior» its receipt prints (owner, 13 Nov 2026)", async () => {
    const t = await lateContract();
    const priceLeft = 13_500_000 - 1_500_000;
    const on = async (date: string) =>
      (await t.get(`/api/customers/${t.ids.customerId}/balances-on?on=${date}`)).contracts.find(
        (row: { contractId: string }) => row.contractId === t.ids.contractId,
      );

    // Before cuota 1 fell due: nothing late, no mora.
    const early = await on(shiftDays(FIRST_DUE, -5));
    assert.deepEqual([early.balance, early.moraPending], [priceLeft, 0]);

    // Today: all L 400, the same saldo the contract shows.
    const now = await on(TODAY);
    assert.deepEqual([now.balance, now.moraPending], [priceLeft + OWED, OWED]);
    const row = (await t.get("/api/contracts")).contracts.find((entry: { id: string }) => entry.id === t.ids.contractId);
    assert.equal(now.balance, row.balance);

    // After cuota 1's charge and before cuota 2's: L 200.
    const between = shiftDays(FIRST_DUE, 10);
    const then = await on(between);
    assert.deepEqual([then.balance, then.moraPending], [priceLeft + EACH, EACH]);

    // Saved with that date, its receipt starts from that figure.
    const response = await t.pay(CUOTA, undefined, { paidOn: between });
    assert.equal(response.statusCode, 201, response.body);
    const receipt = response.json().receipt;
    assert.equal(receipt.lines[0].previousBalance, then.balance);
    assert.equal(receipt.previousBalance, then.balance);

    const bad = await t.app.inject({
      method: "GET",
      url: `/api/customers/${t.ids.customerId}/balances-on?on=ayer`,
      headers: { cookie: t.cookie },
    });
    assert.equal(bad.statusCode, 400);
    await t.close();
  });

  it("the owner's screenshot: a prima dated months back pays no mora charged since", async () => {
    // Cuota 1 is late with L 200 charged; the prima is unpaid.
    const t = await lateContract();
    t.db.delete(payments).where(eq(payments.contractId, t.ids.contractId)).run();
    const prima = 1_500_000;
    const url = `/api/contracts/${t.ids.contractId}/after-payment?amountCents=${prima}`;
    const back = shiftDays(TODAY, -90);

    const today = await t.get(url);
    assert.ok(today.mora > 0, "today the mora is paid first");
    assert.equal(today.toDownPayment, prima - today.mora);

    const dated = await t.get(`${url}&paidOn=${back}`);
    assert.equal(dated.mora, 0);
    assert.equal(dated.toDownPayment, prima);
    // The mora is still owed afterwards, and in the saldo.
    assert.equal(dated.moraPending, today.mora + today.moraPending);
    assert.equal(dated.newBalance, today.newBalance);
    await t.close();
  });

  it("no mora: forgives it with the payment, linked to the receipt, in the Historial", async () => {
    const t = await lateContract();
    const response = await t.pay(CUOTA, { amountCents: 0, reason: REASON });
    assert.equal(response.statusCode, 201, response.body);
    const receipt = response.json().receipt;

    // The whole payment went to cuota 1; none of it to mora.
    assert.deepEqual(receipt.lines[0].moraPaid, []);
    assert.equal(receipt.lines[0].moraPending, 0);
    assert.equal(await t.pending(), 0);

    const mora = await t.get(`/api/contracts/${t.ids.contractId}/mora`);
    assert.deepEqual(
      mora.forgiven.map((entry: { installment: number; amountCents: number; reason: string }) => [
        entry.installment,
        entry.amountCents,
        entry.reason,
      ]),
      [
        [1, EACH, REASON],
        [2, EACH, REASON],
      ],
    );

    const forgiven = (await t.audit()).filter((event: { action: string }) => event.action === "mora_forgive");
    assert.equal(forgiven.length, 2);
    assert.equal(forgiven[0].after.receiptCode, receipt.code);
    assert.equal(forgiven[0].reason, REASON);
    // Each cuota's «Mora por pagar», before and after: L 200 → L 0.
    assert.deepEqual(
      forgiven.map((event: { before: { moraPendingCents: number }; after: { moraPendingCents: number } }) => [
        event.before.moraPendingCents,
        event.after.moraPendingCents,
      ]),
      [
        [EACH, 0],
        [EACH, 0],
      ],
    );
    await t.close();
  });

  it("less: forgives the oldest mora first and the payment pays the rest", async () => {
    const t = await lateContract();
    // L 100 to stay: L 300 off, cuota 1's L 200 and L 100 of cuota 2's.
    const response = await t.pay(CUOTA, { amountCents: 10_000, reason: REASON });
    assert.equal(response.statusCode, 201, response.body);

    const mora = await t.get(`/api/contracts/${t.ids.contractId}/mora`);
    assert.deepEqual(
      mora.forgiven.map((entry: { installment: number; amountCents: number }) => [entry.installment, entry.amountCents]),
      [
        [1, EACH],
        [2, 10_000],
      ],
    );
    // «La mora primero»: the L 100 left is paid first.
    assert.deepEqual(response.json().receipt.lines[0].moraPaid, [{ installment: 2, amount: 10_000 }]);
    // Historial says what each cuota owed before the payment, not after it.
    const filed = (await t.audit())
      .filter((event: { action: string }) => event.action === "mora_forgive")
      .map((event: { after: { moraInstallment: number; moraPendingCents: number }; before: { moraPendingCents: number } }) => [
        event.after.moraInstallment,
        event.before.moraPendingCents,
        event.after.moraPendingCents,
      ])
      .sort((a: number[], b: number[]) => a[0]! - b[0]!);
    assert.deepEqual(filed, [
      [1, EACH, 0],
      [2, EACH, 10_000],
    ]);
    await t.close();
  });

  it("more: charges the difference on the oldest late cuota, today", async () => {
    const t = await lateContract();
    const response = await t.pay(60_000, { amountCents: 60_000, reason: "Acordado con el cliente: L 600 de mora." });
    assert.equal(response.statusCode, 201, response.body);

    const mora = await t.get(`/api/contracts/${t.ids.contractId}/mora`);
    assert.deepEqual(
      mora.manual.map((entry: { installment: number; incurredOn: string; amountCents: number }) => [
        entry.installment,
        entry.incurredOn,
        entry.amountCents,
      ]),
      [[1, TODAY, 20_000]],
    );
    const paid = response.json().receipt.lines[0].moraPaid.reduce(
      (total: number, entry: { amount: number }) => total + entry.amount,
      0,
    );
    assert.equal(paid, 60_000);
    assert.equal(await t.pending(), 0);
    const filed = (await t.audit()).find((event: { action: string }) => event.action === "mora_charge");
    assert.equal(filed.before.moraPendingCents, EACH);
    assert.equal(filed.after.moraPendingCents, 2 * EACH);
    await t.close();
  });

  it("voiding the receipt takes the mora change back with it", async () => {
    const t = await lateContract();
    const issued = (await t.pay(CUOTA, { amountCents: 0, reason: REASON })).json().receipt;
    assert.equal(await t.pending(), 0);

    const voided = await t.app.inject({
      method: "POST",
      url: `/api/receipts/${issued.id}/void`,
      headers: { cookie: t.cookie },
      payload: { reason: "El cheque del cliente rebotó." },
    });
    assert.equal(voided.statusCode, 200, voided.body);

    assert.equal(await t.pending(), OWED);
    assert.deepEqual((await t.get(`/api/contracts/${t.ids.contractId}/mora`)).forgiven, []);
    const undone = (await t.audit()).filter((event: { action: string }) => event.action === "mora_unforgive");
    assert.equal(undone.length, 2);
    assert.match(undone[0].reason, new RegExp(`Anulado con el recibo ${issued.code}`));
    await t.close();
  });

  it("refuses without the permission, on another day, with a short reason, and changes nothing", async () => {
    const t = await lateContract();

    const staff = await t.pay(CUOTA, { amountCents: 0, reason: REASON }, {}, t.staffCookie);
    assert.equal(staff.statusCode, 403, staff.body);

    const yesterday = await t.pay(CUOTA, { amountCents: 0, reason: REASON }, { paidOn: shiftDays(TODAY, -1) });
    assert.equal(yesterday.statusCode, 400);
    assert.equal(yesterday.json().error, "mora_needs_today");

    const short = await t.pay(CUOTA, { amountCents: 0, reason: "corto" });
    assert.equal(short.statusCode, 400);
    assert.match(short.json().message, /por qué cambias la mora/);

    assert.equal(await t.pending(), OWED);
    assert.equal((await t.get(`/api/contracts/${t.ids.contractId}/mora`)).forgiven.length, 0);
    await t.close();
  });

  it("a payment without a mora change is exactly as before, for the associate too", async () => {
    const t = await lateContract();
    const response = await t.pay(CUOTA, undefined, {}, t.staffCookie);
    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(response.json().receipt.lines[0].moraPaid, [
      { installment: 1, amount: EACH },
      { installment: 2, amount: EACH },
    ]);
    await t.close();
  });
});
