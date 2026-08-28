import { defineConfig } from "drizzle-kit";

/**
 * Configuration for the `drizzle-kit` CLI, which turns schema.ts into SQL
 * migration files. It is a development tool only — it never runs in production.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? "./data/lindero.db",
  },
});
