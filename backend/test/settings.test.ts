import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { auditEvents, contracts, moraRules } from "../src/db/schema.js";
import { shiftDays } from "../src/lib/contracts.js";
import { DEFAULT_SETTINGS, clearSection, readMoraHistory, writeSection } from "../src/lib/settings.js";
import { businessToday } from "../src/lib/time.js";
import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

describe("the Configuración screen", async () => {
  const { app, db, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);
  const today = businessToday("America/Tegucigalpa");

  const read = async (cookie: string) =>
    (await app.inject({ method: "GET", url: "/api/settings", headers: { cookie } })).json();

  const save = (cookie: string, payload: unknown) =>
    app.inject({ method: "PUT", url: "/api/settings", headers: { cookie }, payload });

  const grant = (capabilities: string[]) =>
    app.inject({
      method: "PUT",
      url: "/api/permissions",
      headers: { cookie: ownerCookie },
      payload: { capabilities },
    });

  const settingsRows = () =>
    db.select().from(auditEvents).where(eq(auditEvents.entityType, "settings")).all();

  it("starts from the values that used to be hardcoded, and anyone can read them", async () => {
    const settings = await read(staffCookie);

    assert.deepEqual(settings, DEFAULT_SETTINGS);
    assert.equal(settings.mora.enabled, false);
    assert.equal(settings.mora.graceDays, 5);
    assert.equal(settings.contracts.atRiskPayments, 2);
    assert.equal(settings.contracts.reservationMonths, 1);
    assert.equal(settings.business.name, "Inversiones Manuel");
  });

  it("never lets the associate change the mora, even when granted the rest", async () => {
    // Asking for it is refused outright: it is not a switch on Permisos.
    const escalation = await grant(["mora:edit"]);
    assert.equal(escalation.statusCode, 400);
    assert.equal(escalation.json().error, "locked_capability");

    assert.equal((await grant(["settings:edit"])).statusCode, 200);

    const settings = await read(staffCookie);
    const switchOff = await save(staffCookie, {
      mora: { ...settings.mora, graceDays: 10 },
    });
    assert.equal(switchOff.statusCode, 403);
    assert.match(switchOff.json().message, /la mora/);
    assert.equal((await read(ownerCookie)).mora.graceDays, 5);
  });

  it("lets an associate with the permission change the business details", async () => {
    const settings = await read(staffCookie);

    // The whole screen is sent, mora included; an unchanged mora is not a change.
    const response = await save(staffCookie, {
      ...settings,
      business: { ...settings.business, phone: "+504 9999-0000" },
    });

    assert.equal(response.statusCode, 200);
    assert.equal((await read(ownerCookie)).business.phone, "+504 9999-0000");

    const rows = settingsRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.entityId, "business");
    assert.equal(rows[0]!.actorId, ids.staffId);
  });

  it("refuses the associate everything once the permission is taken back", async () => {
    assert.equal((await grant([])).statusCode, 200);

    const settings = await read(staffCookie);
    const response = await save(staffCookie, {
      contracts: { ...settings.contracts, reservationMonths: 3 },
    });

    assert.equal(response.statusCode, 403);
  });

  it("refuses values out of range or empty", async () => {
    const settings = await read(ownerCookie);

    for (const payload of [
      { contracts: { ...settings.contracts, reservationMonths: 0 } },
      { mora: { ...settings.mora, graceDays: 40 } },
      { business: { ...settings.business, name: "  " } },
      { business: { ...settings.business, email: "no es un correo" } },
    ]) {
      assert.equal((await save(ownerCookie, payload)).statusCode, 400);
    }
  });

  it("never switches mora on backwards", async () => {
    const settings = await read(ownerCookie);
    const on = { ...settings.mora, enabled: true, calculation: "percent", percent: 2 };

    const backwards = await save(ownerCookie, { mora: { ...on, startsOn: shiftDays(today, -1) } });
    assert.equal(backwards.statusCode, 400);
    assert.match(backwards.json().message, /hacia atrás/);

    const noRate = await save(ownerCookie, { mora: { ...on, percent: 0, startsOn: today } });
    assert.equal(noRate.statusCode, 400);

    const fromToday = await save(ownerCookie, { mora: { ...on, startsOn: today } });
    assert.equal(fromToday.statusCode, 200);
    assert.equal((await read(staffCookie)).mora.enabled, true);

    const moraRows = settingsRows().filter((row) => row.entityId === "mora");
    assert.equal(moraRows.length, 1);
    assert.equal(JSON.parse(moraRows[0]!.beforeJson!).enabled, false);
    assert.equal(JSON.parse(moraRows[0]!.afterJson!).percent, 2);
  });

  it("lets «Desde» go back to a date already in force, and only to one", async () => {
    // As on the site: mora on from four days ago, then «Desde» moved to
    // yesterday by a save that has been in force since today.
    const settings = await read(ownerCookie);
    const on = { ...settings.mora, enabled: true, calculation: "percent", percent: 2 };
    const fourDaysAgo = shiftDays(today, -4);
    const yesterday = shiftDays(today, -1);
    const version = (id: string, effectiveFrom: string, rules: object) =>
      db.insert(moraRules).values({ id, effectiveFrom, value: JSON.stringify(rules) }).run();

    db.delete(moraRules).run();
    version("first", shiftDays(today, -3), { ...on, startsOn: fourDaysAgo });
    version("moved", today, { ...on, startsOn: yesterday });
    writeSection(db, "mora", { ...on, startsOn: yesterday }, ids.ownerId);

    // Never in force: still charging backwards.
    const earlier = await save(ownerCookie, { mora: { ...on, startsOn: shiftDays(today, -6) } });
    assert.equal(earlier.statusCode, 400);
    assert.match(earlier.json().message, /hacia atrás/);

    // In force until yesterday: an undo, filed from tomorrow like any save.
    const undo = await save(ownerCookie, { mora: { ...on, startsOn: fourDaysAgo } });
    assert.equal(undo.statusCode, 200);
    assert.equal((await read(staffCookie)).mora.startsOn, fourDaysAgo);
    assert.deepEqual(
      readMoraHistory(db).map((entry) => [entry.effectiveFrom, entry.rules.startsOn]),
      [
        [shiftDays(today, -3), fourDaysAgo],
        [today, yesterday],
        [shiftDays(today, 1), fourDaysAgo],
      ],
    );

    // Mora switched off in between breaks the chain: the cuotas that fell due
    // while it was off were never going to be charged.
    db.delete(moraRules).run();
    version("first", shiftDays(today, -3), { ...on, startsOn: fourDaysAgo });
    version("off", shiftDays(today, -2), { ...on, enabled: false, startsOn: fourDaysAgo });
    version("back-on", today, { ...on, startsOn: yesterday });
    writeSection(db, "mora", { ...on, startsOn: yesterday }, ids.ownerId);

    const acrossOff = await save(ownerCookie, { mora: { ...on, startsOn: fourDaysAgo } });
    assert.equal(acrossOff.statusCode, 400);
    assert.match(acrossOff.json().message, /hacia atrás/);

    db.delete(moraRules).run();
    clearSection(db, "mora");
  });

  it("keeps the minimum unpaid for mora, and reads older rules as having none", async () => {
    const settings = await read(ownerCookie);
    const saved = await save(ownerCookie, { mora: { ...settings.mora, minUnpaidCents: 10_000 } });

    assert.equal(saved.statusCode, 200);
    assert.equal((await read(staffCookie)).mora.minUnpaidCents, 10_000);
    assert.equal(readMoraHistory(db).at(-1)!.rules.minUnpaidCents, 10_000);

    // Rules filed before the setting existed have no such field.
    const { minUnpaidCents: _dropped, ...older } = settings.mora;
    db.insert(moraRules)
      .values({ id: "older-rules", effectiveFrom: "2000-01-01", value: JSON.stringify(older) })
      .run();
    assert.equal(readMoraHistory(db)[0]!.rules.minUnpaidCents, null);
    db.delete(moraRules).where(eq(moraRules.id, "older-rules")).run();
  });

  it("files nothing when nothing changed", async () => {
    const before = settingsRows().length;
    const response = await save(ownerCookie, await read(ownerCookie));

    assert.equal(response.statusCode, 200);
    assert.equal(settingsRows().length, before);
  });

  it("decides «Atrasado» with the grace days set here", async () => {
    // A financed contract whose first cuota fell due three days ago, unpaid.
    // The fixture's payments add up to exactly the prima.
    const firstDueOn = shiftDays(today, -3);
    db.update(contracts)
      .set({
        kind: "contract",
        saleType: "financed",
        salePriceCents: 13_500_000,
        downPaymentCents: 1_500_000,
        termMonths: 12,
        monthlyPaymentCents: 1_000_000,
        dueDay: Number(firstDueOn.slice(8, 10)),
        signedOn: shiftDays(today, -40),
        firstDueOn,
      })
      .where(eq(contracts.id, ids.contractId))
      .run();

    const statusNow = async () => {
      const list = (
        await app.inject({ method: "GET", url: "/api/contracts", headers: { cookie: ownerCookie } })
      ).json();
      return list.contracts.find((row: { id: string }) => row.id === ids.contractId).health.status;
    };

    assert.equal(await statusNow(), "due_soon");

    const settings = await read(ownerCookie);
    assert.equal(
      (await save(ownerCookie, { mora: { ...settings.mora, graceDays: 2 } })).statusCode,
      200,
    );

    assert.equal(await statusNow(), "overdue");
  });
});
