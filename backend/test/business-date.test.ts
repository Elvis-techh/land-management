import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config/env.js";
import { businessToday } from "../src/lib/time.js";
import { OWNER_PASSWORD, buildTestApp, login } from "./helpers.js";

/** The office's zone. Honduras keeps UTC−6 all year — no daylight saving since 2006. */
const HN = "America/Tegucigalpa";

describe("what day the business thinks it is", () => {
  it("is still yesterday in the office while UTC has already rolled over", () => {
    /*
     * The reported bug, to the minute: 21:38 on 31 August in Tegucigalpa is
     * 03:38 on 1 September in UTC. The app said September.
     *
     * Everything downstream of this is a date in the ledger — the day a payment
     * was received, whether an installment is late, which month the Panel
     * General opens on — so an hour of drift is a whole day of wrong answers.
     */
    const thatEvening = new Date("2026-09-01T03:38:00Z");

    assert.equal(businessToday(HN, thatEvening), "2026-08-31");
    // What the code used to do, kept here as the contrast that explains the fix.
    assert.equal(thatEvening.toISOString().slice(0, 10), "2026-09-01");
  });

  it("rolls over at local midnight, not six hours early", () => {
    // 23:59:59 on the 31st, local.
    assert.equal(businessToday(HN, new Date("2026-09-01T05:59:59Z")), "2026-08-31");
    // 00:00:00 on the 1st, local.
    assert.equal(businessToday(HN, new Date("2026-09-01T06:00:00Z")), "2026-09-01");
  });

  it("carries the month and the year over with it", () => {
    // The evening of 31 December is the case where being a day out is also a
    // year out, and every contract code is stamped with the year.
    assert.equal(businessToday(HN, new Date("2027-01-01T03:00:00Z")), "2026-12-31");
  });

  it("is unaffected by whatever timezone the server itself is set to", () => {
    // The same instant, asked of three zones. Only the configured one decides,
    // which is what lets the app run on a VPS in UTC without moving any dates.
    const instant = new Date("2026-09-01T03:38:00Z");

    assert.equal(businessToday("UTC", instant), "2026-09-01");
    assert.equal(businessToday("America/Tegucigalpa", instant), "2026-08-31");
    assert.equal(businessToday("Asia/Tokyo", instant), "2026-09-01");
  });

  it("pads a single-digit month and day, so the string is always sortable", () => {
    // "2026-1-5" would compare wrong against every other date in the database.
    assert.equal(businessToday(HN, new Date("2026-01-05T18:00:00Z")), "2026-01-05");
  });
});

describe("configuring the zone", () => {
  it("defaults to the office's own", () => {
    assert.equal(loadConfig({}).timeZone, "America/Tegucigalpa");
  });

  it("takes an override, so a second office is configuration and not a rewrite", () => {
    assert.equal(loadConfig({ TIME_ZONE: "America/Guatemala" }).timeZone, "America/Guatemala");
  });

  it("refuses to boot on a zone that does not exist", () => {
    // Silently falling back to UTC would move every date in the app by six
    // hours, and nothing on any screen would say so.
    assert.throws(
      () => loadConfig({ TIME_ZONE: "Honduras/Tegucigalpa" }),
      /not a known IANA timezone/,
    );
  });
});

describe("telling the browser which zone to use", () => {
  it("publishes the zone with the session, so there is one authority for it", async () => {
    const { app } = await buildTestApp({ timeZone: "America/Guatemala" });

    // On sign-in...
    const loggedIn = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "owner@test.hn", password: OWNER_PASSWORD },
    });

    assert.equal(loggedIn.json().businessTimeZone, "America/Guatemala");

    // ...and again when an open tab restores its session on reload, which is
    // the path that runs far more often.
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
    const restored = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });

    assert.equal(restored.json().businessTimeZone, "America/Guatemala");

    await app.close();
  });

  it("reports the same zone the dates are computed in", async () => {
    // The point of publishing it: a form pre-filled in the browser and a
    // payment filed by the server must land on the same day. If these two ever
    // disagree, the zone has two sources again.
    const { app } = await buildTestApp({ timeZone: "Asia/Tokyo" });
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const session = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    const dashboard = await app.inject({ method: "GET", url: "/api/dashboard", headers: { cookie } });

    assert.equal(
      dashboard.json().today,
      businessToday(session.json().businessTimeZone),
    );

    await app.close();
  });
});
