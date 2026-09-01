import { loadConfig } from "../config/env.js";
import { createDb } from "./client.js";
import { runMigrations } from "./migrations.js";

/**
 * `npm run db:migrate` — apply pending migrations to the database and exit.
 *
 * The server also runs migrations on boot (see server.ts), so a deploy does
 * not depend on this script. It stays for development, and for the times you
 * want to migrate a database without starting the server.
 */
const config = loadConfig();
const { db, sqlite } = createDb(config.databasePath);

runMigrations(db);
sqlite.close();

console.log(`Migrations applied to ${config.databasePath}`);
