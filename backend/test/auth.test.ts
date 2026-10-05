import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { auditEvents, users } from "../src/db/schema.js";
import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

describe("authentication", async () => {
  const { app, db, sqlite } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  it("signs in with correct credentials and sets an HTTP-only cookie", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "owner@test.hn", password: OWNER_PASSWORD },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().user.role, "owner");

    const cookie = response.cookies.find((entry) => entry.name === "lindero_session");
    assert.ok(cookie, "session cookie must be set");
    // JavaScript in the page must not be able to read the session.
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite?.toLowerCase(), "lax");
  });

  it("rejects a wrong password", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "owner@test.hn", password: "incorrecta" },
    });

    assert.equal(response.statusCode, 401);
  });

  it("gives the same answer for an unknown email as for a wrong password", async () => {
    // Otherwise an attacker can discover which accounts exist.
    const unknown = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nadie@test.hn", password: "loquesea" },
    });

    assert.equal(unknown.statusCode, 401);
    assert.equal(unknown.json().error, "invalid_credentials");
  });

  it("rejects a malformed request body", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "owner@test.hn" },
    });

    assert.equal(response.statusCode, 400);
  });

  it("reports the signed-in user from /auth/me", async () => {
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const response = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().user.email, "owner@test.hn");
  });

  it("refuses /auth/me without a session", async () => {
    const response = await app.inject({ method: "GET", url: "/api/auth/me" });
    assert.equal(response.statusCode, 401);
  });

  it("invalidates the session on logout", async () => {
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });

    const afterLogout = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie },
    });

    // The session is destroyed server-side, so the old cookie is worthless even
    // if someone kept a copy of it.
    assert.equal(afterLogout.statusCode, 401);
  });

  it("ignores an invented session id", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: "lindero_session=totally-made-up" },
    });

    assert.equal(response.statusCode, 401);
  });

  it("leaves no row in the Historial for a login", async () => {
    // A permanent row per sign-in said only that somebody opened the app. See
    // `AuditEntry`.
    const before = db.select().from(auditEvents).all().length;
    await login(app, "owner@test.hn", OWNER_PASSWORD);

    assert.equal(db.select().from(auditEvents).all().length, before);
  });

  it("keeps the last sign-in on the account instead", async () => {
    const lastSignIn = () =>
      db
        .select({ at: users.lastSignInAt })
        .from(users)
        .where(eq(users.email, "staff@test.hn"))
        .get()?.at;

    assert.equal(lastSignIn(), null, "an account that has never signed in has no date");

    // A wrong password is not a sign-in.
    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "staff@test.hn", password: "incorrecta" },
    });
    assert.equal(lastSignIn(), null);

    const started = Date.now();
    await login(app, "staff@test.hn", STAFF_PASSWORD);

    const stamped = lastSignIn();
    assert.ok(stamped, "a successful sign-in stamps the account");
    assert.ok(Date.parse(stamped) >= started, "and the stamp is when it happened");
  });
});

describe("login rate limiting", async () => {
  // A separate app with a deliberately tiny limit, so the protection itself is
  // tested rather than tripped over by the other tests.
  const { app, sqlite } = await buildTestApp({ loginAttemptsPerMinute: 3 });
  after(async () => {
    await app.close();
    sqlite.close();
  });

  it("blocks repeated failed logins from the same address", async () => {
    const attempt = () =>
      app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "owner@test.hn", password: "adivinando" },
      });

    assert.equal((await attempt()).statusCode, 401);
    assert.equal((await attempt()).statusCode, 401);
    assert.equal((await attempt()).statusCode, 401);

    // Fourth attempt within the window is refused outright, so a script cannot
    // sit there guessing passwords.
    assert.equal((await attempt()).statusCode, 429);
  });

  it("keeps blocking even when the correct password is finally supplied", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "owner@test.hn", password: OWNER_PASSWORD },
    });

    assert.equal(response.statusCode, 429);
  });
});
