import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { contracts, moraRules } from "../src/db/schema.js";
import { addMonthsOnDay, shiftDays } from "../src/lib/contracts.js";
import type { MoraSettings } from "../src/lib/settings.js";
import { DEFAULT_SETTINGS, readMoraHistory, writeSection } from "../src/lib/settings.js";
import { businessToday } from "../src/lib/time.js";
import { OWNER_PASSWORD, buildTestApp, login } from "./helpers.js";

/*
 * Mora through the routes: the contract, the payment preview, the receipt, the
 * Panel and the Configuración save, on one contract that is two cuotas late.
 *
 * The fixture contract becomes a financed sale: L 135,000 with a L 15,000
 * prima (which the fixture's two payments cover exactly) and cuotas of
 * L 10,000. Cuota 1 fell due 40 days ago and cuota 2 about ten days ago, both
 * unpaid. Mora has been on, at 2 %, since 60 days ago — set straight in its
 * history, since the screen only allows a start from today on.
 */

const TODAY = businessToday("America/Tegucigalpa");
const FIRST_DUE = shiftDays(TODAY, -40);
const SECOND_DUE = addMonthsOnDay(FIRST_DUE, 1, Number(FIRST_DUE.slice(8, 10)));

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

async function lateContract(
  rules: MoraSettings = RULES,
  terms: Partial<typeof contracts.$inferInsert> = {},
) {
  const built = await buildTestApp();
  const { db, ids } = built;

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
      ...terms,
    })
    .where(eq(contracts.id, ids.contractId))
    .run();

  const cookie = await login(built.app, "owner@test.hn", OWNER_PASSWORD);

  const turnOn = () => {
    writeSection(db, "mora", rules, ids.ownerId);
    db.insert(moraRules)
      .values({
        id: randomUUID(),
        effectiveFrom: rules.startsOn!,
        value: JSON.stringify(rules),
        recordedBy: ids.ownerId,
      })
      .run();
  };

  const contract = async () => {
    const response = await built.app.inject({
      method: "GET",
      url: "/api/contracts",
      headers: { cookie },
    });
    return response
      .json()
      .contracts.find((row: { id: string }) => row.id === ids.contractId);
  };

  const pay = (amountCents: number, extra: Record<string, unknown> = {}) =>
    built.app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie },
      payload: {
        customerId: ids.customerId,
        paidOn: TODAY,
        method: "cash",
        lines: [{ contractId: ids.contractId, amountCents, type: "installment" }],
        ...extra,
      },
    });

  return { ...built, cookie, turnOn, contract, pay };
}

describe("charging mora", async () => {
  const { app, sqlite, ids, cookie, turnOn, contract, pay } = await lateContract();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  it("charges nothing while mora has never been switched on", async () => {
    const row = await contract();

    assert.deepEqual(row.mora, { charged: 0, paid: 0, pending: 0 });
    assert.equal(row.balance, 13_500_000 - 1_500_000);
    assert.equal(row.health.monthsBehind, 2);
  });

  it("charges each late cuota and adds it to the balance, apart from the cuotas", async () => {
    turnOn();
    const row = await contract();

    // 2 % of each unpaid L 10,000 cuota.
    assert.deepEqual(row.mora, { charged: 40_000, paid: 0, pending: 40_000 });
    assert.equal(row.balance, 12_000_000 + 40_000);
    // Mora is not a cuota: the arrears and «Atrasado» are as before.
    assert.equal(row.health.arrears, 2_000_000);
    assert.equal(row.health.monthsBehind, 2);
  });

  it("puts the pending mora on the Panel, on its own line", async () => {
    const response = await app.inject({ method: "GET", url: "/api/dashboard", headers: { cookie } });
    const income = response.json().income;

    assert.deepEqual(income.mora, { pendingCents: 40_000, contracts: 1, collectedCents: 0 });
  });

  it("previews a payment covering the mora first", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/contracts/${ids.contractId}/after-payment?amountCents=1040000`,
      headers: { cookie },
    });
    const preview = response.json();

    assert.equal(preview.mora, 40_000);
    assert.equal(preview.moraPending, 0);
    assert.deepEqual(
      preview.appliedTo.map((entry: { number: number; settled: boolean }) => [entry.number, entry.settled]),
      [[1, true]],
    );
    assert.equal(preview.newBalance, 11_000_000);
  });

  it("prints the mora on the receipt, and the summary still adds up", async () => {
    const response = await pay(1_040_000);
    assert.equal(response.statusCode, 201, response.body);
    const receipt = response.json().receipt;
    const line = receipt.lines[0];

    assert.deepEqual(line.moraPaid, [
      { installment: 1, amount: 20_000 },
      { installment: 2, amount: 20_000 },
    ]);
    assert.equal(line.moraPending, 0);
    assert.deepEqual(
      line.appliedTo.map((entry: { number: number; settled: boolean }) => [entry.number, entry.settled]),
      [[1, true]],
    );

    assert.equal(receipt.previousBalance, 12_040_000);
    assert.equal(receipt.newBalance, 11_000_000);
    assert.equal(receipt.moraCharged, 40_000);
    // Valor + mora − total pagado = nuevo balance, on the page.
    assert.equal(line.contractTotal + receipt.moraCharged - receipt.cumulativePaid, receipt.newBalance);
  });

  it("counts the mora as paid, and only the rest towards the cuotas", async () => {
    const row = await contract();

    assert.deepEqual(row.mora, { charged: 40_000, paid: 40_000, pending: 0 });
    assert.equal(row.paidToDate, 1_500_000 + 1_040_000);
    assert.equal(row.balance, 11_000_000);
    assert.equal(row.health.monthsBehind, 1);

    const dashboard = await app.inject({ method: "GET", url: "/api/dashboard", headers: { cookie } });
    assert.deepEqual(dashboard.json().income.mora, {
      pendingCents: 0,
      contracts: 0,
      collectedCents: 40_000,
    });
  });

  it("refuses an overpayment against the balance with the mora in it", async () => {
    const response = await pay(11_000_001);

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().balanceCents, 11_000_000);
  });

  it("files a change of the rules from tomorrow, leaving today's charges as they were", async () => {
    const settings = (
      await app.inject({ method: "GET", url: "/api/settings", headers: { cookie } })
    ).json();

    const saved = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { cookie },
      payload: { mora: { ...settings.mora, percent: 5 } },
    });
    assert.equal(saved.statusCode, 200, saved.body);

    const history = readMoraHistory(app.db);
    assert.deepEqual(
      history.map((version) => [version.effectiveFrom, version.rules.percent]),
      [
        [RULES.startsOn, 2],
        [shiftDays(TODAY, 1), 5],
      ],
    );

    assert.equal((await contract()).mora.charged, 40_000);
  });
});

describe("a contract whose cuotas are paid and whose mora is not", async () => {
  // Two cuotas only, both late, and the cuotas covered first: paying them
  // completes the price and leaves the mora.
  const { app, sqlite, turnOn, contract, pay } = await lateContract(
    { ...RULES, paymentOrder: "cuota" },
    { salePriceCents: 3_500_000, termMonths: 2 },
  );
  after(async () => {
    await app.close();
    sqlite.close();
  });

  it("stays open, owing the mora, rather than turning «Pagado»", async () => {
    turnOn();

    // The mora is all that remains, so the contract is not paid off and has
    // no constancia.
    const response = await pay(2_000_000);
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().receipt.newBalance, 40_000);

    const row = await contract();
    assert.equal(row.status, "active");
    assert.deepEqual(row.mora, { charged: 40_000, paid: 0, pending: 40_000 });
    assert.equal(row.balance, 40_000);
    assert.equal(row.health.settled, true);
  });

  it("turns «Pagado» once the mora is paid too", async () => {
    const response = await pay(40_000);
    assert.equal(response.statusCode, 201, response.body);

    const row = await contract();
    assert.equal(row.status, "paid_off");
    assert.equal(row.balance, 0);
  });
});
