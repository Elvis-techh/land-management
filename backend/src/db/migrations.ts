import type Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import type { Db } from "./client.js";

/**
 * Applies any migration files in ./drizzle that this database has not seen,
 * with foreign keys disabled for the duration.
 *
 * That last part is not a shortcut, it is SQLite's own documented procedure for
 * changing a column — and it has to happen HERE rather than inside the .sql
 * file, which is the whole reason this function exists.
 *
 * SQLite cannot alter a column in place. Dropping NOT NULL means building a new
 * table, copying the rows across, dropping the old one and renaming the new one
 * into its place. `DROP TABLE customers` with foreign keys enforced is a
 * foreign key violation the moment a single contract points at a customer, so
 * SQLite's instructions say to turn enforcement off around the rebuild and
 * check the result afterwards.
 *
 * `PRAGMA foreign_keys` is a NO-OP inside a transaction, and Drizzle's migrator
 * wraps every pending migration in one `BEGIN`. So the `PRAGMA foreign_keys=OFF`
 * that drizzle-kit helpfully writes at the top of a generated rebuild does
 * nothing at all, and the migration fails on any database that holds real data
 * while passing cleanly on the empty one in front of you. It has to be set out
 * here, around the transaction, where it takes effect.
 *
 * `foreign_key_check` afterwards is what keeps that honest. Enforcement being
 * off means a careless migration could leave a contract pointing at a customer
 * who no longer exists, and nothing would say so until something broke months
 * later. This turns that into a failure at deploy time, before the server
 * starts, with the offending rows named.
 */
export function runMigrations(db: Db, sqlite: Database.Database, migrationsFolder = "./drizzle"): void {
  sqlite.pragma("foreign_keys = OFF");

  try {
    migrate(db, { migrationsFolder });

    const violations = sqlite.pragma("foreign_key_check") as Array<{
      table: string;
      rowid: number;
      parent: string;
    }>;

    if (violations.length > 0) {
      const summary = violations
        .slice(0, 5)
        .map((row) => `${row.table} row ${row.rowid} → ${row.parent}`)
        .join(", ");

      throw new Error(
        `Las migraciones dejaron ${violations.length} referencia(s) rota(s): ${summary}. ` +
          "La base de datos NO se ha iniciado.",
      );
    }
  } finally {
    // Back on even when a migration threw: the connection stays open long
    // enough for the caller to report the error, and nothing should be able to
    // write to it unguarded in the meantime.
    sqlite.pragma("foreign_keys = ON");
  }
}
