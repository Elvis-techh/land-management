import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const src = join(import.meta.dirname, "..", "src");

/** The code without its comments, which mention PRAGMA and SQLite freely. */
const withoutComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");

/**
 * The SQLite-only spots docs/postgres-readiness.md lists, and where each one
 * is today: file (under backend/src) → how many times it appears.
 *
 * Every one of these works today and is not a bug. Each is a place a move to
 * PostgreSQL has to change by hand, so the map has to know about it.
 */
const SPOTS: Array<{ name: string; pattern: RegExp; known: Record<string, number> }> = [
  {
    name: "the SQLite driver",
    pattern: /["'](?:better-sqlite3|drizzle-orm\/better-sqlite3[^"']*)["']/g,
    known: { "db/client.ts": 2, "db/migrations.ts": 2 },
  },
  {
    name: "Drizzle's SQLite builders (sqliteTable, alias…)",
    pattern: /["']drizzle-orm\/sqlite-core["']/g,
    known: { "db/schema.ts": 2, "routes/audit.ts": 1, "routes/contracts.ts": 1, "routes/transactions.ts": 1 },
  },
  {
    name: "PRAGMA",
    pattern: /\bPRAGMA\b|\.pragma\(/gi,
    known: { "db/client.ts": 4, "db/migrations.ts": 3, "routes/transactions.ts": 1 },
  },
  {
    name: "SQLite error codes",
    pattern: /\bSQLITE_[A-Z_]+/g,
    known: { "routes/contracts.ts": 1 },
  },
  {
    name: "CAST, which PostgreSQL refuses on text that is not a number",
    pattern: /\bCAST\(/gi,
    known: { "routes/contracts.ts": 1 },
  },
  {
    name: "LIKE, which is case-sensitive in PostgreSQL",
    pattern: /\bLIKE\b/g,
    known: { "routes/contracts.ts": 2, "routes/dashboard.ts": 1 },
  },
  {
    name: "SUM( and COUNT(, which PostgreSQL's driver returns as text",
    pattern: /\b(?:SUM|COUNT)\(/g,
    known: {
      "routes/audit.ts": 1,
      "routes/contracts.ts": 7,
      "routes/customers.ts": 1,
      "routes/dashboard.ts": 5,
      "routes/lots.ts": 1,
      "routes/projects.ts": 8,
      "routes/receipts.ts": 1,
      "routes/transactions.ts": 2,
      "routes/users.ts": 1,
    },
  },
  {
    name: "MAX(, the next number allocated under SQLite's one writer",
    pattern: /\bMAX\(/g,
    known: { "routes/constancias.ts": 1, "routes/contracts.ts": 1, "routes/dashboard.ts": 1, "routes/receipts.ts": 1 },
  },
  {
    name: "CURRENT_TIMESTAMP, whose text PostgreSQL writes differently",
    pattern: /\bCURRENT_TIMESTAMP\b/g,
    known: { "db/schema.ts": 1 },
  },
];

function found(pattern: RegExp): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const file of readdirSync(src, { recursive: true }).map(String).sort()) {
    if (!file.endsWith(".ts")) {
      continue;
    }

    const matches = withoutComments(readFileSync(join(src, file), "utf8")).match(pattern);

    if (matches) {
      counts[file.split("\\").join("/")] = matches.length;
    }
  }

  return counts;
}

/*
 * Keeps docs/postgres-readiness.md true. It fails when SQLite-only code is
 * added or removed, so the map is updated in the same pull request, and the
 * day Lindero moves to PostgreSQL starts from a complete list.
 */
describe("PostgreSQL readiness map", () => {
  for (const spot of SPOTS) {
    it(`knows every use of ${spot.name}`, () => {
      assert.deepEqual(
        found(spot.pattern),
        spot.known,
        `${spot.name} changed in backend/src. Prefer plain Drizzle where you can. If it has to stay, ` +
          "update its section in docs/postgres-readiness.md and the `known` list in this test.",
      );
    });
  }
});
