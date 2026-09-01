import { loadConfig } from "../config/env.js";
import { createDb } from "./client.js";
import { runMigrations } from "./migrations.js";

/**
 * Applies any migration files in ./drizzle that this database has not seen.
 *
 * Safe to run repeatedly — Drizzle records which migrations have run. This is
 * what you run on deploy, before starting the server. The foreign key handling
 * that a table rebuild needs lives in `runMigrations`, which explains itself.
 */
const config = loadConfig();
const { db, sqlite } = createDb(config.databasePath);

runMigrations(db, sqlite);
sqlite.close();

console.log(`Migrations applied to ${config.databasePath}`);
