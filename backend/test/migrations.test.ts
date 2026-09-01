import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrations.js";

/**
 * A migrations folder holding one migration, so a single file can be run
 * against a database shaped the way it will really find one.
 *
 * The suite's own database is migrated from nothing, which is the one state a
 * destructive migration is guaranteed to survive. These tests exist because
 * that is not the state a migration meets on deploy.
 */
function folderWith(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lindero-migration-"));

  mkdirSync(join(dir, "meta"));
  cpSync(join("drizzle", `${tag}.sql`), join(dir, `${tag}.sql`));
  writeFileSync(
    join(dir, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "sqlite",
      entries: [{ idx: 0, version: "6", when: 1, tag, breakpoints: true }],
    }),
  );

  return dir;
}

/** The `customers` and `contracts` tables exactly as they stood before 0007. */
function databaseBefore0007() {
  const { db, sqlite } = createDb(":memory:");

  sqlite.exec(`
    CREATE TABLE customers (
      id text PRIMARY KEY NOT NULL,
      full_name text NOT NULL,
      identification text NOT NULL,
      phone text NOT NULL,
      email text,
      address text,
      customer_since integer NOT NULL,
      notes text,
      created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at text
    );
    CREATE UNIQUE INDEX customers_identification_unique ON customers (identification);
    CREATE TABLE contracts (
      id text PRIMARY KEY NOT NULL,
      customer_id text NOT NULL,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );
  `);

  return { db, sqlite };
}

describe("0007 — making the identidad optional", () => {
  it("rebuilds the customers table without orphaning the contracts pointing at it", () => {
    const { db, sqlite } = databaseBefore0007();

    sqlite.exec(`
      INSERT INTO customers (id, full_name, identification, phone, customer_since)
        VALUES ('c1', 'Ana Portillo', '0801-1990-00001', '+50499824471', 2024);
      INSERT INTO contracts (id, customer_id) VALUES ('k1', 'c1');
    `);

    // The whole point. A rebuild drops `customers`, and with foreign keys
    // enforced that is a violation the moment one contract references one
    // customer — which passes on an empty database and fails on every real one.
    runMigrations(db, sqlite, folderWith("0007_optional_identification"));

    const joined = sqlite
      .prepare(
        "SELECT c.full_name FROM contracts k JOIN customers c ON c.id = k.customer_id WHERE k.id = 'k1'",
      )
      .get() as { full_name: string } | undefined;

    assert.equal(joined?.full_name, "Ana Portillo");
    assert.deepEqual(sqlite.pragma("foreign_key_check"), []);
    // And enforcement is back on afterwards, not left off for the server.
    assert.deepEqual(sqlite.pragma("foreign_keys"), [{ foreign_keys: 1 }]);

    sqlite.close();
  });

  it("turns an identidad that was only ever blank into a real absence", () => {
    const { db, sqlite } = databaseBefore0007();

    // What the old NOT NULL column forced on anybody without a number.
    sqlite.exec(`
      INSERT INTO customers (id, full_name, identification, phone, customer_since)
        VALUES ('c1', 'Sin identidad', '   ', '+50499824471', 2024);
    `);

    runMigrations(db, sqlite, folderWith("0007_optional_identification"));

    const row = sqlite
      .prepare("SELECT identification FROM customers WHERE id = 'c1'")
      .get() as { identification: string | null };

    assert.equal(row.identification, null);

    // The reason it has to be NULL and not "": a second customer without an
    // identidad must be storable, and two empty strings collide in the index.
    sqlite
      .prepare(
        "INSERT INTO customers (id, full_name, identification, phone, customer_since) VALUES (?, ?, ?, ?, ?)",
      )
      .run("c2", "Tampoco tiene", null, "+50499824472", 2024);

    const withoutId = sqlite
      .prepare("SELECT COUNT(*) AS n FROM customers WHERE identification IS NULL")
      .get() as { n: number };

    assert.equal(withoutId.n, 2);

    sqlite.close();
  });

  it("still refuses a real identidad that is already on file", () => {
    const { db, sqlite } = databaseBefore0007();

    sqlite.exec(`
      INSERT INTO customers (id, full_name, identification, phone, customer_since)
        VALUES ('c1', 'Ana Portillo', '0801-1990-00001', '+50499824471', 2024);
    `);

    runMigrations(db, sqlite, folderWith("0007_optional_identification"));

    assert.throws(
      () =>
        sqlite
          .prepare(
            "INSERT INTO customers (id, full_name, identification, phone, customer_since) VALUES (?, ?, ?, ?, ?)",
          )
          .run("c2", "Otra persona", "0801-1990-00001", "+50499824472", 2024),
      /UNIQUE/,
    );

    sqlite.close();
  });
});

describe("0008 — accounts that can be switched off", () => {
  it("leaves every existing account able to sign in", () => {
    const { db, sqlite } = createDb(":memory:");

    // The `users` table as it stood before 0008, with people already in it.
    sqlite.exec(`
      CREATE TABLE users (
        id text PRIMARY KEY NOT NULL,
        email text NOT NULL,
        name text NOT NULL,
        role text NOT NULL,
        password_hash text NOT NULL,
        created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
      CREATE UNIQUE INDEX users_email_unique ON users (email);
      INSERT INTO users (id, email, name, role, password_hash)
        VALUES ('u1', 'owner@lindero.hn', 'Dueña', 'owner', 'scrypt$aa$bb'),
               ('u2', 'staff@lindero.hn', 'Asociado', 'staff', 'scrypt$cc$dd');
    `);

    runMigrations(db, sqlite, folderWith("0008_user_accounts"));

    // NULL reads as "active" everywhere, which is the point: running this
    // migration must not lock the business out of its own application.
    const active = sqlite
      .prepare("SELECT COUNT(*) AS n FROM users WHERE deactivated_at IS NULL")
      .get() as { n: number };

    assert.equal(active.n, 2);
    assert.deepEqual(sqlite.pragma("foreign_key_check"), []);

    sqlite.close();
  });
});
