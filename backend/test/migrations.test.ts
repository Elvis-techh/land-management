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

describe("0014 — dropping the receipt that was never superseded", () => {
  /**
   * `receipts` as it stood before 0014, with the two tables that point at it.
   *
   * Both matter. `payments.receipt_id` and `attachments.receipt_id` are the
   * references that make dropping the table a foreign-key violation on any
   * database that has ever issued a receipt — which is the case an empty test
   * database cannot produce and a deploy always can.
   */
  function databaseBefore0014() {
    const { db, sqlite } = createDb(":memory:");

    sqlite.exec(`
      CREATE TABLE customers (id text PRIMARY KEY NOT NULL, full_name text NOT NULL);
      CREATE TABLE users (id text PRIMARY KEY NOT NULL, name text NOT NULL);
      CREATE TABLE receipts (
        id text PRIMARY KEY NOT NULL,
        number integer NOT NULL,
        code text NOT NULL,
        lookup_code text NOT NULL,
        customer_id text NOT NULL,
        issued_on text NOT NULL,
        issued_by text NOT NULL,
        idempotency_key text,
        note text,
        voided_at text,
        void_reason text,
        voided_by text,
        superseded_by_id text,
        created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
        FOREIGN KEY (customer_id) REFERENCES customers(id),
        FOREIGN KEY (issued_by) REFERENCES users(id),
        FOREIGN KEY (voided_by) REFERENCES users(id),
        FOREIGN KEY (superseded_by_id) REFERENCES receipts(id)
      );
      CREATE UNIQUE INDEX receipts_number_unique ON receipts (number);
      CREATE UNIQUE INDEX receipts_code_unique ON receipts (code);
      CREATE UNIQUE INDEX receipts_lookup_code_unique ON receipts (lookup_code);
      CREATE UNIQUE INDEX receipts_idempotency_key_unique ON receipts (idempotency_key);
      CREATE TABLE payments (
        id text PRIMARY KEY NOT NULL,
        receipt_id text,
        amount_cents integer NOT NULL,
        FOREIGN KEY (receipt_id) REFERENCES receipts(id)
      );
      CREATE TABLE attachments (
        id text PRIMARY KEY NOT NULL,
        receipt_id text NOT NULL,
        file_name text NOT NULL,
        FOREIGN KEY (receipt_id) REFERENCES receipts(id)
      );
    `);

    return { db, sqlite };
  }

  it("rebuilds the table without orphaning the payments printed on it", () => {
    const { db, sqlite } = databaseBefore0014();

    sqlite.exec(`
      INSERT INTO customers (id, full_name) VALUES ('c1', 'Ana Portillo');
      INSERT INTO users (id, name) VALUES ('u1', 'Dueña');
      INSERT INTO receipts (id, number, code, lookup_code, customer_id, issued_on, issued_by)
        VALUES ('r1', 1, 'IM-482739156034', 'ABCD-EFGH', 'c1', '2026-03-15', 'u1');
      INSERT INTO payments (id, receipt_id, amount_cents) VALUES ('p1', 'r1', 4000000);
      INSERT INTO attachments (id, receipt_id, file_name) VALUES ('a1', 'r1', 'deposito.pdf');
    `);

    runMigrations(db, sqlite, folderWith("0014_drop_superseded"));

    // The money and the proof are still attached to the receipt they were
    // printed on, through a table that has been dropped and rebuilt under them.
    const joined = sqlite
      .prepare(
        "SELECT r.code, p.amount_cents FROM payments p JOIN receipts r ON r.id = p.receipt_id WHERE p.id = 'p1'",
      )
      .get() as { code: string; amount_cents: number } | undefined;

    assert.equal(joined?.code, "IM-482739156034");
    assert.equal(joined?.amount_cents, 4000000);

    const proof = sqlite
      .prepare("SELECT receipt_id FROM attachments WHERE id = 'a1'")
      .get() as { receipt_id: string };

    assert.equal(proof.receipt_id, "r1");
    assert.deepEqual(sqlite.pragma("foreign_key_check"), []);
    assert.deepEqual(sqlite.pragma("foreign_keys"), [{ foreign_keys: 1 }]);

    sqlite.close();
  });

  it("leaves the column gone and every other field intact", () => {
    const { db, sqlite } = databaseBefore0014();

    sqlite.exec(`
      INSERT INTO customers (id, full_name) VALUES ('c1', 'Ana Portillo');
      INSERT INTO users (id, name) VALUES ('u1', 'Dueña');
      INSERT INTO receipts
        (id, number, code, lookup_code, customer_id, issued_on, issued_by, note, voided_at, void_reason, voided_by)
        VALUES ('r1', 7, 'IM-482739156034', 'ABCD-EFGH', 'c1', '2026-03-15', 'u1',
                'Pago de marzo', '2026-03-20T10:00:00.000Z', 'Cheque sin fondos', 'u1');
    `);

    runMigrations(db, sqlite, folderWith("0014_drop_superseded"));

    const columns = (sqlite.pragma("table_info(receipts)") as Array<{ name: string }>).map(
      (column) => column.name,
    );

    assert.ok(!columns.includes("superseded_by_id"));

    // A void is the one thing on a receipt that the dashboard reads back, so
    // the rebuild has to carry it across rather than merely keeping the row.
    const row = sqlite.prepare("SELECT * FROM receipts WHERE id = 'r1'").get() as Record<
      string,
      unknown
    >;

    assert.equal(row.number, 7);
    assert.equal(row.note, "Pago de marzo");
    assert.equal(row.void_reason, "Cheque sin fondos");
    assert.equal(row.voided_by, "u1");

    sqlite.close();
  });

  it("keeps the unique indexes that stop a receipt number being reused", () => {
    const { db, sqlite } = databaseBefore0014();

    sqlite.exec(`
      INSERT INTO customers (id, full_name) VALUES ('c1', 'Ana Portillo');
      INSERT INTO users (id, name) VALUES ('u1', 'Dueña');
      INSERT INTO receipts (id, number, code, lookup_code, customer_id, issued_on, issued_by)
        VALUES ('r1', 1, 'IM-482739156034', 'ABCD-EFGH', 'c1', '2026-03-15', 'u1');
    `);

    runMigrations(db, sqlite, folderWith("0014_drop_superseded"));

    // Recreated after the rename, not inherited. A rebuild that forgot them
    // would let the sequence hand out a number twice and nothing would complain
    // until two customers held the same receipt number.
    assert.throws(
      () =>
        sqlite
          .prepare(
            "INSERT INTO receipts (id, number, code, lookup_code, customer_id, issued_on, issued_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run("r2", 1, "IM-999999999999", "WXYZ-WXYZ", "c1", "2026-03-16", "u1"),
      /UNIQUE/,
    );

    sqlite.close();
  });
});
