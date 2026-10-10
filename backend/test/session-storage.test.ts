import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { sessions } from "../src/db/schema.js";
import { OWNER_PASSWORD, buildTestApp, login } from "./helpers.js";

/*
 * The nightly backup copies the database to the bucket, and copies get pulled
 * down to a laptop. Whoever holds one must not be able to sign in with what is
 * in the sessions table (code review P2-1).
 */
describe("what the sessions table keeps", async () => {
  const { app, db, sqlite } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const me = (cookie: string) =>
    app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });

  it("does not keep the token the browser holds", async () => {
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
    const token = cookie.slice("lindero_session=".length);

    const stored = db.select({ id: sessions.id }).from(sessions).all().map((row) => row.id);

    assert.ok(stored.length > 0);
    assert.ok(!stored.includes(token), "the raw token must not be in the database");
    assert.equal((await me(cookie)).statusCode, 200, "the browser's own cookie still works");
  });

  it("signs nobody in with a session id copied out of a backup", async () => {
    await login(app, "owner@test.hn", OWNER_PASSWORD);

    for (const { id } of db.select({ id: sessions.id }).from(sessions).all()) {
      assert.equal((await me(`lindero_session=${id}`)).statusCode, 401);
    }
  });

  it("still deletes the session on logout", async () => {
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
    const before = db.select().from(sessions).all().length;

    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });

    assert.equal(db.select().from(sessions).all().length, before - 1);
    assert.equal((await me(cookie)).statusCode, 401);
  });
});
