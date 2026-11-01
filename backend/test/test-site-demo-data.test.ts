import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import Database from "better-sqlite3";

import { loadConfig } from "../src/config/env.js";
import { demoPasswords } from "../src/db/demoLogins.js";
import { verifyPassword } from "../src/lib/password.js";

const backend = join(import.meta.dirname, "..");
const tsx = join(backend, "..", "node_modules", ".bin", "tsx");

// Made up on each run, and read from the code: no password is written in this file.
const SUPERVISOR_PASSWORD = randomBytes(16).toString("hex");
const ASSOCIATE_PASSWORD = randomBytes(16).toString("hex");
const PUBLISHED = demoPasswords({ site: "live" });

/** A scratch data folder, and the environment of a server pointed at it. */
function site(extra: Record<string, string> = {}) {
  const data = mkdtempSync(join(tmpdir(), "test-site-data-"));
  return {
    databasePath: join(data, "lindero.db"),
    uploadsPath: join(data, "uploads"),
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "production",
      COOKIE_SECRET: "x".repeat(48),
      DATABASE_PATH: join(data, "lindero.db"),
      UPLOADS_PATH: join(data, "uploads"),
      ...extra,
    },
  };
}

function run(script: "migrate" | "seed" | "reset", env: Record<string, string>) {
  return spawnSync(tsx, [`src/db/${script}.ts`], { cwd: backend, env, encoding: "utf8" });
}

const testSite = {
  LINDERO_SITE: "test",
  TEST_SITE_SUPERVISOR_PASSWORD: SUPERVISOR_PASSWORD,
  TEST_SITE_ASSOCIATE_PASSWORD: ASSOCIATE_PASSWORD,
};

/*
 * Seeding and resetting are the two most dangerous scripts in the repository:
 * one writes fictional data, the other deletes the database. They stayed safe
 * by refusing production outright. The test site runs in production mode too,
 * and needs both, so they now also accept LINDERO_SITE=test.
 */
describe("the real site still refuses demo data", () => {
  it("will not seed", () => {
    const { env, databasePath } = site();
    assert.equal(run("migrate", env).status, 0);
    const result = run("seed", env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /disabled in production/);

    const db = new Database(databasePath, { readonly: true });
    assert.deepEqual(db.prepare("select count(*) as n from users").get(), { n: 0 });
    db.close();
  });

  it("will not delete the database", () => {
    const { env, databasePath } = site();
    assert.equal(run("migrate", env).status, 0);
    const result = run("reset", env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /disabled in production/);
    assert.ok(existsSync(databasePath));
  });

  it("does not start with a site name it does not know", () => {
    assert.throws(() => loadConfig({ LINDERO_SITE: "prueba" }), /LINDERO_SITE/);
    assert.equal(loadConfig({}).site, "live");
    assert.equal(loadConfig({ LINDERO_SITE: "test" }).site, "test");
  });
});

describe("the test site's demo data", () => {
  it("uses the droplet's passwords, because the ones in this repository are public", async () => {
    const { env, databasePath } = site(testSite);
    assert.equal(run("migrate", env).status, 0);
    const result = run("seed", env);
    assert.equal(result.status, 0, result.stderr);

    const db = new Database(databasePath, { readonly: true });
    const hashOf = (email: string) =>
      (db.prepare("select password_hash as hash from users where email = ?").get(email) as { hash: string }).hash;
    const owner = hashOf("gerencia@lindero.hn");
    const staff = hashOf("asociado@lindero.hn");
    db.close();

    assert.equal(await verifyPassword(SUPERVISOR_PASSWORD, owner), true);
    assert.equal(await verifyPassword(ASSOCIATE_PASSWORD, staff), true);
    assert.equal(await verifyPassword(PUBLISHED.owner, owner), false);
    assert.equal(await verifyPassword(PUBLISHED.staff, staff), false);
  });

  it("never prints a password into the log", () => {
    const { env } = site(testSite);
    assert.equal(run("migrate", env).status, 0);
    const result = run("seed", env);
    assert.equal(result.status, 0, result.stderr);
    for (const secret of [SUPERVISOR_PASSWORD, ASSOCIATE_PASSWORD, PUBLISHED.owner, PUBLISHED.staff]) {
      assert.ok(!result.stdout.includes(secret), secret);
    }
  });

  for (const [why, passwords, message] of [
    ["no passwords set", {}, /TEST_SITE_SUPERVISOR_PASSWORD/],
    ["a short password", { TEST_SITE_SUPERVISOR_PASSWORD: "x".repeat(5), TEST_SITE_ASSOCIATE_PASSWORD: ASSOCIATE_PASSWORD }, /at least/],
    ["a published password", { TEST_SITE_SUPERVISOR_PASSWORD: SUPERVISOR_PASSWORD, TEST_SITE_ASSOCIATE_PASSWORD: PUBLISHED.staff }, /TEST_SITE_ASSOCIATE_PASSWORD/],
  ] as const) {
    it(`refuses ${why}, and writes nothing`, () => {
      const { env, databasePath } = site({ LINDERO_SITE: "test", ...passwords });
      assert.equal(run("migrate", env).status, 0);
      const result = run("seed", env);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);

      const db = new Database(databasePath, { readonly: true });
      assert.deepEqual(db.prepare("select count(*) as n from users").get(), { n: 0 });
      db.close();
    });
  }

  it("is removed whole by a reset: the database and every uploaded file", () => {
    const { env, databasePath, uploadsPath } = site(testSite);
    assert.equal(run("migrate", env).status, 0);
    assert.equal(run("seed", env).status, 0);
    mkdirSync(uploadsPath, { recursive: true });
    writeFileSync(join(uploadsPath, "comprobante.jpg"), "x");

    const result = run("reset", env);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!existsSync(databasePath));
    assert.ok(!existsSync(join(uploadsPath, "comprobante.jpg")));
  });

  it("comes back from a reset ready to log in to", async () => {
    const { env, databasePath } = site(testSite);
    for (const script of ["migrate", "seed", "reset", "migrate", "seed"] as const) {
      const result = run(script, env);
      assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    }
    const db = new Database(databasePath, { readonly: true });
    const { hash } = db.prepare("select password_hash as hash from users where email = ?").get("gerencia@lindero.hn") as { hash: string };
    db.close();
    assert.equal(await verifyPassword(SUPERVISOR_PASSWORD, hash), true);
  });
});

describe("on a developer's laptop", () => {
  it("db:reset still leaves the uploads folder alone", () => {
    const { env, databasePath, uploadsPath } = site({ NODE_ENV: "development" });
    assert.equal(run("migrate", env).status, 0);
    mkdirSync(uploadsPath, { recursive: true });
    writeFileSync(join(uploadsPath, "comprobante.jpg"), "x");

    assert.equal(run("reset", env).status, 0);
    assert.ok(!existsSync(databasePath));
    assert.ok(existsSync(join(uploadsPath, "comprobante.jpg")));
  });

  it("db:seed still uses the published demo passwords", async () => {
    const { env, databasePath } = site({ NODE_ENV: "development" });
    assert.equal(run("migrate", env).status, 0);
    const result = run("seed", env);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(PUBLISHED.owner));

    const db = new Database(databasePath, { readonly: true });
    const { hash } = db.prepare("select password_hash as hash from users where email = ?").get("gerencia@lindero.hn") as { hash: string };
    db.close();
    assert.equal(await verifyPassword(PUBLISHED.owner, hash), true);
  });
});
