import { defineConfig } from "drizzle-kit";

/**
 * Like drizzle.config.ts, for the accounts database (src/db/accountsSchema.ts):
 *
 *   npx drizzle-kit generate --config drizzle.accounts.config.ts
 *
 * A development tool only — it never runs in production.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/accountsSchema.ts",
  out: "./drizzle-accounts",
  dbCredentials: {
    url: process.env.ACCOUNTS_PATH ?? "./data/accounts.db",
  },
});
