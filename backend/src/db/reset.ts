import { rmSync } from "node:fs";

import { loadConfig } from "../config/env.js";

/**
 * Deletes the SQLite file so `db:migrate` + `db:seed` can rebuild it.
 *
 * Development only. It refuses to run with NODE_ENV=production, because on the
 * droplet this would destroy real customer records.
 *
 * The one exception is the test site (LINDERO_SITE=test), where nothing is real.
 * It also empties the uploads there: the files belong to the rows being deleted.
 * A laptop keeps its uploads, as it always has.
 */
const config = loadConfig();

if (config.nodeEnv === "production" && config.site !== "test") {
  throw new Error("db:reset is disabled in production");
}

for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${config.databasePath}${suffix}`, { force: true });
}

if (config.site === "test") {
  rmSync(config.uploadsPath, { recursive: true, force: true });
}

console.log(`Deleted ${config.databasePath} — run db:migrate and db:seed to rebuild.`);
