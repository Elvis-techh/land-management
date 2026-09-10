import assert from "node:assert/strict";
import { after, describe, it, mock } from "node:test";

import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";
import { readCurrentRate, refreshAutomaticRate } from "../src/lib/exchangeRate.js";

/** Answer the provider call with a fixed payload — no test touches the network. */
function stubProvider(rate: number) {
  return mock.method(globalThis, "fetch", async () =>
    Response.json({ result: "success", rates: { HNL: rate } }),
  );
}

function stubProviderFailure() {
  return mock.method(globalThis, "fetch", async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  });
}

describe("the displayed exchange rate", async () => {
  const { app, db, sqlite } = await buildTestApp();
  after(async () => {
    mock.restoreAll();
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

  const read = async (cookie = ownerCookie) =>
    (await app.inject({ method: "GET", url: "/api/exchange-rate", headers: { cookie } })).json();

  it("falls back to a placeholder before any reading exists", async () => {
    const body = await read();

    assert.equal(body.source, "default");
    assert.equal(body.capturedAt, null);
    // A number nobody has vouched for is stale by definition.
    assert.equal(body.isStale, true);
  });

  it("is readable by anyone signed in, since money is on every screen", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/exchange-rate",
      headers: { cookie: staffCookie },
    });
    assert.equal(response.statusCode, 200);
  });

  it("stores an automatic reading from the provider", async () => {
    const fetchMock = stubProvider(26.822577);

    const result = await refreshAutomaticRate(db);
    assert.equal(result.status, "updated");

    const body = await read();
    assert.equal(body.rate, 26.822577);
    assert.equal(body.source, "auto");
    assert.equal(body.isStale, false);

    fetchMock.mock.restore();
  });

  it("refuses a manual rate from the associate", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/exchange-rate",
      headers: { cookie: staffCookie },
      payload: { rate: 30 },
    });
    assert.equal(response.statusCode, 403);
  });

  it("takes a manual rate from the supervisor", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/exchange-rate",
      headers: { cookie: ownerCookie },
      payload: { rate: 25.5 },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().rate, 25.5);
    assert.equal(response.json().source, "manual");
  });

  it("refuses a rate that cannot be right", async () => {
    for (const rate of [0, -3, 2682, 0.5]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/exchange-rate",
        headers: { cookie: ownerCookie },
        payload: { rate },
      });
      assert.equal(response.statusCode, 400, `rate ${rate} should be refused`);
    }

    // And the good value from before is untouched.
    assert.equal((await read()).rate, 25.5);
  });

  it("leaves a manual rate alone on the automatic refresh", async () => {
    const fetchMock = stubProvider(26.9);

    const result = await refreshAutomaticRate(db);

    assert.equal(result.status, "skipped_manual");
    assert.equal((await read()).rate, 25.5);
    assert.equal(fetchMock.mock.callCount(), 0, "it should not even ask the provider");

    fetchMock.mock.restore();
  });

  it("returns to automatic only when the supervisor asks", async () => {
    const fetchMock = stubProvider(27.1);

    const response = await app.inject({
      method: "POST",
      url: "/api/exchange-rate/auto",
      headers: { cookie: ownerCookie },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().rate, 27.1);
    assert.equal(response.json().source, "auto");

    fetchMock.mock.restore();
  });

  it("keeps the last known rate when the provider is unreachable", async () => {
    const fetchMock = stubProviderFailure();

    const manual = await app.inject({
      method: "POST",
      url: "/api/exchange-rate/auto",
      headers: { cookie: ownerCookie },
    });
    assert.equal(manual.statusCode, 502);
    assert.equal(manual.json().error, "provider_unavailable");

    // Nothing was written: a failed fetch is not a reading.
    assert.equal((await read()).rate, 27.1);

    const scheduled = await refreshAutomaticRate(db);
    assert.equal(scheduled.status, "failed");
    assert.equal(readCurrentRate(db).rate, 27.1);

    fetchMock.mock.restore();
  });

  it("keeps every reading, so an old figure can still be explained", async () => {
    const rates = db.all<{ rate: string; source: string }>(
      "SELECT rate, source FROM exchange_rates ORDER BY captured_at",
    );

    assert.deepEqual(
      rates.map((row) => row.source),
      ["auto", "manual", "auto"],
    );
  });

  it("files rate changes in the history", async () => {
    const events = (
      await app.inject({ method: "GET", url: "/api/audit", headers: { cookie: ownerCookie } })
    ).json().events;

    const change = events.find(
      (event: { entityType: string }) => event.entityType === "exchange_rate",
    );

    assert.ok(change, "a rate change should appear in the history");
    assert.equal(change.action, "update");
  });
});

/*
 * A separate app and database from the block above, which depends on the order
 * its own readings were written in.
 */
describe("nudging the displayed rate off the provider's figure", async () => {
  const { app, db, sqlite } = await buildTestApp();
  after(async () => {
    mock.restoreAll();
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

  const read = async () =>
    (await app.inject({ method: "GET", url: "/api/exchange-rate", headers: { cookie: ownerCookie } })).json();

  const setAdjustment = (percent: number, cookie = ownerCookie) =>
    app.inject({
      method: "POST",
      url: "/api/exchange-rate/adjustment",
      headers: { cookie },
      payload: { percent },
    });

  it("shows the provider's figure as it came, until somebody says otherwise", async () => {
    const fetchMock = stubProvider(26.811824);

    await refreshAutomaticRate(db);
    const body = await read();

    assert.equal(body.rate, 26.811824);
    assert.equal(body.providerRate, 26.811824);
    assert.equal(body.adjustmentPercent, 0);

    fetchMock.mock.restore();
  });

  it("applies the adjustment and keeps the provider's own number beside it", async () => {
    const response = await setAdjustment(0.33);

    assert.equal(response.statusCode, 200);

    const body = response.json();
    // 26.811824 * 1.0033 — the figure the office was searching for.
    assert.equal(body.rate, 26.900303);
    assert.equal(body.providerRate, 26.811824);
    assert.equal(body.adjustmentPercent, 0.33);
  });

  it("keeps the adjustment in force on the next scheduled refresh", async () => {
    const fetchMock = stubProvider(27);

    const result = await refreshAutomaticRate(db);
    assert.equal(result.status, "updated");

    const body = await read();
    assert.equal(body.providerRate, 27);
    assert.equal(body.rate, 27.0891, "the calibration must survive a refresh nobody asked for");
    assert.equal(body.adjustmentPercent, 0.33);

    fetchMock.mock.restore();
  });

  it("re-derives without asking the provider again", async () => {
    const fetchMock = stubProvider(99);

    const body = (await setAdjustment(-0.5)).json();

    assert.equal(fetchMock.mock.callCount(), 0, "the figure on file is enough to re-derive from");
    assert.equal(body.providerRate, 27);
    assert.equal(body.rate, 26.865);

    fetchMock.mock.restore();
  });

  it("refuses an adjustment big enough to be an invented rate", async () => {
    const response = await setAdjustment(9);

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "implausible_adjustment");
    // Unchanged.
    assert.equal((await read()).adjustmentPercent, -0.5);
  });

  it("is not something an associate may set", async () => {
    assert.equal((await setAdjustment(0.25, staffCookie)).statusCode, 403);
  });

  it("leaves a typed rate standing, and holds the setting for the way back", async () => {
    const manual = await app.inject({
      method: "POST",
      url: "/api/exchange-rate",
      headers: { cookie: ownerCookie },
      payload: { rate: 27.5 },
    });
    assert.equal(manual.statusCode, 200);
    // A typed rate is a final number: the adjustment is carried, not applied.
    assert.equal(manual.json().rate, 27.5);
    assert.equal(manual.json().adjustmentPercent, -0.5);

    const changed = await setAdjustment(0.4);
    assert.equal(changed.json().rate, 27.5, "changing the dial must not undo an override");
    assert.equal(changed.json().source, "manual");
    assert.equal(changed.json().adjustmentPercent, 0.4);

    const fetchMock = stubProvider(26.8);
    const back = await app.inject({
      method: "POST",
      url: "/api/exchange-rate/auto",
      headers: { cookie: ownerCookie },
    });

    assert.equal(back.json().providerRate, 26.8);
    assert.equal(back.json().rate, 26.9072, "the setting was waiting for it");

    fetchMock.mock.restore();
  });

  it("files the adjustment in the history, with both numbers", async () => {
    const events = (
      await app.inject({ method: "GET", url: "/api/audit", headers: { cookie: ownerCookie } })
    ).json().events;

    const change = events.find(
      (event: { entityType: string; after?: { adjustmentPercent?: number } }) =>
        event.entityType === "exchange_rate" && event.after?.adjustmentPercent !== undefined,
    );

    assert.ok(change, "an adjustment should be answerable for later");
  });
});
