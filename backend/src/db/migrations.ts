import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import type { Db } from "./client.js";

/**
 * Finds the folder of SQL migration files, relative to THIS module rather than
 * the working directory.
 *
 * `migrate(db, { migrationsFolder: "./drizzle" })` resolves that path against
 * `process.cwd()` — fine when the one and only way to run migrations is `npm`
 * scripts invoked from `backend/`, but the server now runs them itself on boot
 * (see server.ts) and a service manager can start it from anywhere.
 *
 * `drizzle-kit` writes the files to `backend/drizzle`. `npm run build` copies
 * them to `backend/dist/drizzle` so a compiled install still has them without
 * the source tree. Both layouts put the folder either one or two levels above
 * this file, so try both:
 *
 *   dist/db/migrations.js  ->  dist/drizzle      (../drizzle, copied by build)
 *   dist/db/migrations.js  ->  backend/drizzle   (../../drizzle, whole tree deployed)
 *   src/db/migrations.ts   ->  backend/drizzle   (../../drizzle, tsx: dev, tests, db:migrate)
 */
function findMigrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "..", "drizzle"), join(here, "..", "..", "drizzle")];

  for (const folder of candidates) {
    // meta/_journal.json is the index drizzle reads first; if it is here, the
    // rest of the folder is too.
    if (existsSync(join(folder, "meta", "_journal.json"))) {
      return folder;
    }
  }

  throw new Error(
    "Could not locate the drizzle migrations folder. Looked in:\n" +
      candidates.map((path) => `  ${path}`).join("\n") +
      "\nA compiled install gets this folder from `npm run build` — check that it ran.",
  );
}

/**
 * Applies every migration this database has not seen yet.
 *
 * Safe to call repeatedly and on every boot: drizzle records which migrations
 * have run in a table of its own and skips them next time. The server calls
 * this at startup, so a production deploy has no separate migration step to
 * remember — but `npm run db:migrate` still runs it on its own when that is
 * what you want.
 */
export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: findMigrationsFolder() });
}
