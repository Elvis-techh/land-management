import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { contracts } from "../src/db/schema.js";
import { shiftDays } from "../src/lib/contracts.js";
import { monthOf, moraOfMonth, shiftMonth } from "../src/lib/dashboard.js";
import type { MoraAccount } from "../src/lib/mora.js";
import { businessToday } from "../src/lib/time.js";
import { OWNER_PASSWORD, buildTestApp, login } from "./helpers.js";

/*
 * «Mora por mes», the Panel's line per month: charged, collected, forgiven and
 * still owed at the end of the month. It only reads; nothing here changes what
 * anybody owes. The two promises checked are that it adds up month to month,
 * and that it agrees with the «Mora pendiente» tile above it.
 */

/** L 500 charged in October, L 100 paid in November, L 150 forgiven in December. */
const ACCOUNT = {
  charges: [{ id: "c1", installment: 1, incurredOn: "2026-10-20", amountCents: 50_000, unpaidCents: 0 }],
  splits: [
    {
      creditId: "p1",
      paidOn: "2026-11-05",
      toMoraCents: 10_000,
      toPriceCents: 0,
      pricePaidBeforeCents: 0,
      pricePaidAfterCents: 0,
      moraPaid: [],
      moraPendingAfterCents: 40_000,
    },
  ],
  forgiven: [
    {
      id: "f1",
      forgivenessId: "f1",
      installment: 1,
      forgivenOn: "2026-12-01",
      recordedAt: "2026-12-01T16:00:00.000Z",
      amountCents: 15_000,
    },
  ],
} as unknown as MoraAccount;

const line = (
  chargedCents: number,
  collectedCents: number,
  forgivenCents: number,
  pendingCents: number,
  leftOnCloseCents = 0,
) => ({ chargedCents, collectedCents, forgivenCents, pendingCents, leftOnCloseCents });

describe("one contract's mora in one month", () => {
  it("counts each amount in the month it happened, and what is owed when the month ends", () => {
    assert.deepEqual(moraOfMonth(ACCOUNT, "2026-09", null), line(0, 0, 0, 0));
    assert.deepEqual(moraOfMonth(ACCOUNT, "2026-10", null), line(50_000, 0, 0, 50_000));
    assert.deepEqual(moraOfMonth(ACCOUNT, "2026-11", null), line(0, 10_000, 0, 40_000));
    assert.deepEqual(moraOfMonth(ACCOUNT, "2026-12", null), line(0, 0, 15_000, 25_000));
    assert.deepEqual(moraOfMonth(ACCOUNT, "2027-01", null), line(0, 0, 0, 25_000));
  });

  it("adds up from one month to the next", () => {
    let pending = 0;

    for (const month of ["2026-10", "2026-11", "2026-12", "2027-01"]) {
      const figures = moraOfMonth(ACCOUNT, month, null);

      pending += figures.chargedCents - figures.collectedCents - figures.forgivenCents;
      assert.equal(figures.pendingCents, pending, month);
    }
  });

  it("stops counting as pending the month the contract closes, and says how much left", () => {
    assert.deepEqual(moraOfMonth(ACCOUNT, "2026-11", "2026-12-10"), line(0, 10_000, 0, 40_000));
    assert.deepEqual(moraOfMonth(ACCOUNT, "2026-12", "2026-12-10"), line(0, 0, 15_000, 0, 25_000));
    assert.deepEqual(moraOfMonth(ACCOUNT, "2027-01", "2026-12-10"), line(0, 0, 0, 0));
  });
});

describe("«Mora por mes» on the Panel", async () => {
  const TODAY = businessToday("America/Tegucigalpa");
  const THIS_MONTH = monthOf(TODAY);
  const LAST_MONTH = shiftMonth(THIS_MONTH, -1);
  const FIRST_DUE = shiftDays(TODAY, -80);
  const LAST_MONTH_DAY = `${LAST_MONTH}-15`;

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
      signedOn: shiftDays(TODAY, -120),
      firstDueOn: FIRST_DUE,
    })
    .where(eq(contracts.id, ids.contractId))
    .run();

  const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

  const post = async (url: string, payload: Record<string, unknown>) => {
    const response = await app.inject({ method: "POST", url, headers: { cookie }, payload });
    assert.equal(response.statusCode, 201, response.body);
  };

  const panel = async (month?: string) =>
    (
      await app.inject({
        method: "GET",
        url: month ? `/api/dashboard?month=${month}` : "/api/dashboard",
        headers: { cookie },
      })
    ).json();

  const rowOf = (dashboard: { moraByMonth: Array<{ month: string }> }, month: string) =>
    dashboard.moraByMonth.find((row) => row.month === month) as unknown as Record<string, number> & {
      contracts: Array<Record<string, number | string>>;
    };

  it("has no lines until there is some mora, and no tile either", async () => {
    const dashboard = await panel();

    assert.deepEqual(dashboard.moraByMonth, []);
    assert.equal(dashboard.income.mora, null);
  });

  it("shows what was charged last month, collected and forgiven this month", async () => {
    const mora = `/api/contracts/${ids.contractId}/mora`;

    await post(mora, { installment: 1, incurredOn: LAST_MONTH_DAY, amountCents: 50_000, reason: "Acordado el mes pasado." });
    await post(mora, { installment: 2, incurredOn: TODAY, amountCents: 30_000, reason: "Acordado con el cliente hoy." });
    await post(`${mora}/forgive`, { installment: 2, amountCents: 10_000, reason: "Se le perdona parte de esta mora." });
    await post("/api/receipts", {
      customerId: ids.customerId,
      paidOn: TODAY,
      method: "cash",
      lines: [{ contractId: ids.contractId, amountCents: 20_000, type: "installment" }],
    });

    const dashboard = await panel();

    assert.deepEqual(
      dashboard.moraByMonth.map((row: { month: string }) => row.month),
      [LAST_MONTH, THIS_MONTH],
    );

    const last = rowOf(dashboard, LAST_MONTH);
    assert.equal(last.chargedCents, 50_000);
    assert.equal(last.collectedCents, 0);
    assert.equal(last.forgivenCents, 0);
    assert.equal(last.pendingCents, 50_000);

    const current = rowOf(dashboard, THIS_MONTH);
    assert.equal(current.chargedCents, 30_000);
    assert.equal(current.collectedCents, 20_000);
    assert.equal(current.forgivenCents, 10_000);
    assert.equal(current.pendingCents, 50_000);
  });

  it("agrees with the tile, month by month", async () => {
    const dashboard = await panel();
    const current = rowOf(dashboard, THIS_MONTH);

    assert.equal(current.pendingCents, dashboard.income.mora.pendingCents);
    assert.equal(current.collectedCents, dashboard.income.mora.collectedCents);

    const earlier = await panel(LAST_MONTH);
    const last = rowOf(earlier, LAST_MONTH);

    assert.equal(last.pendingCents, earlier.income.mora.pendingCents);
    assert.equal(last.collectedCents, earlier.income.mora.collectedCents);
  });

  it("lists the contracts behind a line, and they add up to it", async () => {
    const current = rowOf(await panel(), THIS_MONTH);

    assert.equal(current.contracts.length, 1);
    const [only] = current.contracts;

    assert.equal(only!.contractId, ids.contractId);
    assert.equal(only!.chargedCents, current.chargedCents);
    assert.equal(only!.collectedCents, current.collectedCents);
    assert.equal(only!.forgivenCents, current.forgivenCents);
    assert.equal(only!.pendingCents, current.pendingCents);
    assert.ok(typeof only!.contractCode === "string" && only!.contractCode !== "");
  });

  it("does not show a month past the one being reported", async () => {
    const earlier = await panel(LAST_MONTH);

    assert.deepEqual(
      earlier.moraByMonth.map((row: { month: string }) => row.month),
      [LAST_MONTH],
    );
  });

  it("changes nothing anybody owes: the contract reads the same before and after", async () => {
    const read = async () =>
      (await app.inject({ method: "GET", url: "/api/contracts", headers: { cookie } }))
        .json()
        .contracts.find((row: { id: string }) => row.id === ids.contractId);
    const before = await read();

    await panel();
    assert.deepEqual(await read(), before);
  });

  it("takes a cancelled contract's mora off pending the month it closes, as the tile does", async () => {
    db.update(contracts)
      .set({ status: "cancelled", closedAt: new Date().toISOString() })
      .where(eq(contracts.id, ids.contractId))
      .run();

    const dashboard = await panel();
    const current = rowOf(dashboard, THIS_MONTH);

    assert.equal(dashboard.income.mora.pendingCents, 0);
    assert.equal(current.pendingCents, 0);
    // L 500 less the L 200 paid. Today's L 300 by hand drops out, and with it
    // what was forgiven of it: nothing is charged from the day a contract closes.
    assert.equal(current.leftOnCloseCents, 30_000);
    // Still pending in the month before: it was open then, and that is what
    // both the line and the tile say when that month is the one shown.
    const earlier = await panel(LAST_MONTH);

    assert.equal(rowOf(earlier, LAST_MONTH).pendingCents, 50_000);
    assert.equal(earlier.income.mora.pendingCents, 50_000);
  });
});
