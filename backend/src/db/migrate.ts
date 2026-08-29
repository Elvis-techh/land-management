import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { loadConfig } from "../config/env.js";
import { createDb } from "./client.js";

/**
 * Applies any migration files in ./drizzle that this database has not seen.
 *
 * Safe to run repeatedly — Drizzle records which migrations have run. This is
 * what you run on deploy, before starting the server.
 */
const config = loadConfig();
const { db, sqlite } = createDb(config.databasePath);

migrate(db, { migrationsFolder: "./drizzle" });
sqlite.close();

console.log(`Migrations applied to ${config.databasePath}`);
