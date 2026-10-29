import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { appSettings, contracts, moraContractRules, moraRules, users } from "../src/db/schema.js";
import { shiftDays } from "../src/lib/contracts.js";
import { DEFAULT_SETTINGS } from "../src/lib/settings.js";
import { businessToday } from "../src/lib/time.js";
import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

/*
 * A contract's own mora rule through the routes.
 *
 * The fixture contract becomes a financed sale: L 135,000 with a L 15,000
 * prima (which the fixture's two payments cover exactly) and cuotas of
 * L 10,000, cuota 1 due 40 days ago and cuota 2 ten days ago, both unpaid.
 * Mora has been on for 60 days at 2 %, once, with 5 days of grace, so each
 * cuota carries L 200: cuota 1 from 34 days ago, cuota 2 from 4 days ago.
 */

const TODAY = businessToday("America/Tegucigalpa");
const TOMORROW = shiftDays(TODAY, 1);
const FIRST_DUE = shiftDays(TODAY, -40);

describe("a contract's own mora rule", async () => {
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

  const general = JSON.stringify({
    ...DEFAULT_SETTINGS.mora,
    enabled: true,
    startsOn: shiftDays(TODAY, -60),
    percent: 2,
    graceDays: 5,
  });
  db.insert(appSettings).values({ key: "mora", value: general }).run();
  db.insert(moraRules).values({ id: randomUUID(), effectiveFrom: shiftDays(TODAY, -60), value: general }).run();

  const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);
  const owner = db.select().from(users).where(eq(users.email, "owner@test.hn")).get()!;

  const moraOf = async () =>
    (await app.inject({ method: "GET", url: `/api/contracts/${ids.contractId}/mora`, headers: { cookie } })).json();

  const pending = async () =>
    (await app.inject({ method: "GET", url: "/api/contracts", headers: { cookie } }))
      .json()
      .contracts.find((row: { id: string }) => row.id === ids.contractId).mora.pending;

  const setRule = (payload: Record<string, unknown>, who = cookie) =>
    app.inject({
      method: "POST",
      url: `/api/contracts/${ids.contractId}/mora/rule`,
      headers: { cookie: who },
      payload: { reason: "Cláusula firmada distinta de la general.", ...payload },
    });

  const own = {
    calculation: "fixed",
    percent: 0,
    fixedCents: 50_000,
    capCents: null,
    minUnpaidCents: null,
    frequency: "once",
  };

  /** A version as if it had been set some days ago, to see what it does. */
  const filedSince = (effectiveFrom: string, mode: string, value: unknown = null) =>
    db.insert(moraContractRules)
      .values({
        id: randomUUID(),
        contractId: ids.contractId,
        effectiveFrom,
        mode,
        value: value === null ? null : JSON.stringify(value),
        reason: "Puesta en la prueba.",
        recordedBy: owner.id,
      })
      .run();

  it("starts on the general rule: L 200 on each late cuota", async () => {
    const mora = await moraOf();

    assert.deepEqual(mora.rules, []);
    assert.equal(mora.general.percent, 2);
    assert.equal(await pending(), 40_000);
  });

  it("is only for whoever may charge mora, and always with a reason", async () => {
    assert.equal((await setRule({ mode: "none" }, staffCookie)).statusCode, 403);
    assert.equal((await setRule({ mode: "none", reason: "corto" })).statusCode, 400);
  });

  it("refuses a rule that charges nothing, and one the contract already has", async () => {
    assert.equal((await setRule({ mode: "own", rules: { ...own, fixedCents: 0 } })).statusCode, 400);
    assert.equal((await setRule({ mode: "general" })).statusCode, 400);
  });

  it("counts from tomorrow: the mora already charged stays", async () => {
    const saved = await setRule({ mode: "none" });

    assert.equal(saved.statusCode, 201, saved.body);
    assert.equal(saved.json().effectiveFrom, TOMORROW);

    const mora = await moraOf();
    assert.deepEqual(
      mora.rules.map((version: { effectiveFrom: string; rule: unknown }) => [version.effectiveFrom, version.rule]),
      [[TOMORROW, { mode: "none" }]],
    );
    assert.equal(await pending(), 40_000);
    assert.equal((await setRule({ mode: "none" })).statusCode, 400);
  });

  it("replaces a change made the same day, and undoes it when put back", async () => {
    assert.equal((await setRule({ mode: "own", rules: own })).statusCode, 201);
    let mora = await moraOf();
    assert.deepEqual(
      mora.rules.map((version: { rule: { mode: string } }) => version.rule.mode),
      ["own"],
    );

    assert.equal((await setRule({ mode: "general" })).statusCode, 201);
    mora = await moraOf();
    assert.deepEqual(mora.rules, []);
  });

  it("files every change in the Historial", async () => {
    const events = (await app.inject({ method: "GET", url: "/api/audit", headers: { cookie } }))
      .json()
      .events.filter(
        (event: { entityId: string; action: string }) =>
          event.entityId === ids.contractId && event.action === "mora_rule",
      );

    assert.equal(events.length, 3);
    // The last one: back to the general rule, from the «Regla propia».
    const back = events.find((event: { after: { moraRule: string } }) => event.after.moraRule === "general");
    assert.equal(back.before.moraRule, "own");
    assert.equal(back.before.fixedCents, 50_000);
    assert.deepEqual(back.after, { moraRule: "general", moraRuleFrom: TOMORROW });
  });

  it("«Sin mora» set before a cuota's charge leaves that cuota without mora", async () => {
    // As if set 20 days ago: cuota 1's L 200 (34 days ago) stays, cuota 2's never comes.
    filedSince(shiftDays(TODAY, -20), "none");

    assert.equal(await pending(), 20_000);
  });

  it("«Regla propia» charges its own amount from its day", async () => {
    db.delete(moraContractRules).where(eq(moraContractRules.contractId, ids.contractId)).run();
    filedSince(shiftDays(TODAY, -20), "own", own);

    // L 200 on cuota 1 under the general rule, L 500 on cuota 2 under its own.
    assert.equal(await pending(), 70_000);
  });
});
