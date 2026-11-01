# PostgreSQL readiness map

Lindero keeps its data in SQLite: one file on the server, opened by one
program. That is plenty for one business, and for the first few paying
customers too. This page is written ahead of time. It lists every place that
would have to change if Lindero ever moved to PostgreSQL, so the move can be
planned from a complete list instead of discovered halfway through.

Nothing on this page has been done. Lindero still runs on SQLite only.

The test `backend/test/postgres-readiness.test.ts` keeps section 6 true. It
fails when SQLite-only code is added or removed, and its message says to
update this page in the same pull request.

## 1. When to move, and what comes first

Move when one of these is actually happening, not before:

- Lindero has to run on **more than one server at once**, so it keeps working
  when one is down. A SQLite file lives on one machine.
- Saves start **waiting on each other**: requests slow down at busy times, or
  the log shows "database is locked". SQLite lets one save happen at a time.
- You want **every customer in one shared database**, with reports across all
  of them.
- A customer's contract requires **backups or point-in-time recovery** that
  only a managed database offers.
- The data grows to **tens of gigabytes**, and copying the file for backups
  takes too long.

The first step for paying customers is not PostgreSQL. Lindero is built for
one business: no table says which business a row belongs to. The simplest safe
setup is **one copy of Lindero per customer, each with its own SQLite file**
(its own subdomain, settings and backups). SQLite suits that well, because each
customer's data is physically separate.

The weight station app also uses SQLite. Its own map belongs in its own
repository. Sections 4 and 5 below are the parts most likely to apply there
too.

## 2. How Lindero uses SQLite today

- One file, `DATABASE_PATH` (default `backend/data/lindero.db`), opened by
  `createDb()` in `backend/src/db/client.ts` through **better-sqlite3**, with
  Drizzle ORM on top.
- One Node process, one connection. Four PRAGMAs set it up: WAL,
  foreign keys, a 5-second busy timeout, `synchronous = NORMAL`.
- Every query is **synchronous**: `.all()`, `.get()` and `.run()` return the
  rows directly, and `db.transaction()` takes a normal (not `async`) function.
  Section 5 explains why this matters most.
- The server applies migrations on boot (`runMigrations()` in
  `backend/src/db/migrations.ts`, called from `server.ts`).

## 3. Size of the job

Counted on 29 Oct 2026:

| What | Count | Where |
|---|---|---|
| Tables | 21 | `backend/src/db/schema.ts` |
| Migrations | 26 (`0000` to `0025`) | `backend/drizzle/` |
| `.get()` calls | 107 | 17 files |
| `.all()` calls | 58 | 19 files |
| `.run()` calls | 56 | 19 files |
| `db.transaction()` blocks | 36 | 13 files |
| Backend test files | 51 | `backend/test/` |

The busiest files: `routes/receipts.ts` (13 / 26 / 10 / 5, in that order),
`routes/contracts.ts` (8 / 26 / 7 / 6), `routes/lots.ts` (3 / 11 / 2 / 3),
`routes/projects.ts`, `routes/users.ts`, `routes/constancias.ts`,
`routes/transactions.ts`, `routes/mora.ts`. Library files that read the
database are called from routes, so they turn async too:
`lib/moraAccounts.ts`, `lib/settings.ts`, `lib/preferences.ts`,
`lib/capabilities.ts`, `lib/constancias.ts`, `lib/contractLifecycle.ts`,
`lib/exchangeRate.ts`, `lib/storedFiles.ts`, `lib/audit.ts`,
`auth/session.ts`.

Estimate: one to two weeks of careful work, most of it sections 4 and 5, plus
the tests.

## 4. Every query becomes async

With PostgreSQL, Drizzle returns promises. The mechanical part:

| SQLite today | PostgreSQL |
|---|---|
| `query.all()` | `await query` |
| `query.get()` | `(await query.limit(1))[0]` |
| `query.run()` | `await query` |
| `insert(...).returning().get()` | `(await insert(...).returning())[0]` |
| `db.transaction((tx) => { ... })` | `await db.transaction(async (tx) => { ... })` |
| `db.get<T>(sql\`...\`)` | `(await db.execute(sql\`...\`)).rows[0]` |

Every function that calls one of these becomes `async`, and so does every
function that calls *that* one. The compiler (`npm run typecheck`) finds most of
them. The ones it misses are a promise used as if it were a value, for example
`if (holder)` on a promise, which is always true. Use the
`@typescript-eslint/no-floating-promises` and `no-misused-promises` rules for
that pass.

## 5. What only works because SQLite has one writer

This is the risky part, and the reason not to treat the move as a search and
replace.

Today, nothing else can happen between two lines of a request handler that
have no `await` between them: the queries are synchronous, and Node runs one
thing at a time. So "read, check, then write" is safe even outside a
transaction. With PostgreSQL every query is an `await`, another request can run
in between, and two people can pass the same check at the same moment.

Places that depend on this today, and what each needs:

| Rule it protects | Where | Under PostgreSQL |
|---|---|---|
| One holder per lot (no double sale) | `POST /contracts` reads the holder (`holdsLot`) before its transaction; also «Editar términos», «Corregir lote» (reassign-lot) and the lot routes in `routes/lots.ts` | Do the check inside the transaction and lock the lot row first (`SELECT ... FOR UPDATE`). A unique index cannot do it: whether a lapsed reservation still holds depends on the date. |
| Gapless receipt numbers | `MAX(receipts.number) + 1` in `routes/receipts.ts` | A counter row updated with `UPDATE ... RETURNING`, or a transaction-level advisory lock. The unique index stays as the backstop. |
| Constancia numbers | `MAX(constancias.number) + 1` in `routes/constancias.ts` | Same as receipts. |
| Contract codes `CT-YYYY-NNN` and adenda codes `-A1` | `nextContractCode` and the `LIKE` on codes in `routes/contracts.ts`, retried on a unique violation | Same lock, and see section 6 for `CAST` and the error code. |
| A receipt's random code never repeats | `allocateReceiptCode` checks, then inserts, in `routes/receipts.ts` | Inside the transaction plus the unique index, retrying on a clash. |
| The same payment is not entered twice | The `lower(trim(reference))` check in `routes/receipts.ts`, and the idempotency key | The idempotency key has a unique index already. The reference check needs the lock or a retry. |
| Rules saved the same day replace each other | `onConflictDoUpdate` on `mora_rules` and `mora_contract_rules` | Works the same in PostgreSQL. |

For each one, write a test that sends two requests at the same moment and
expects exactly one to succeed, *before* changing the code.

Live updates (`lib/changes.ts`) and the exchange-rate timer stay correct with
one server. Only a second server would need PostgreSQL's `LISTEN/NOTIFY` for
the live updates.

## 6. SQLite-only code (kept up to date by the test)

| Spot | Where | Change |
|---|---|---|
| The driver (`better-sqlite3`, `drizzle-orm/better-sqlite3`) | `db/client.ts`, `db/migrations.ts` | `pg` (node-postgres) with `drizzle-orm/node-postgres`; a pool instead of one connection; `DATABASE_URL` instead of `DATABASE_PATH`. |
| `drizzle-orm/sqlite-core` (`sqliteTable`, `alias`) | `db/schema.ts`, `routes/audit.ts`, `routes/contracts.ts`, `routes/transactions.ts` | `drizzle-orm/pg-core` (`pgTable`, `alias`). |
| `PRAGMA` (WAL, foreign keys, busy timeout, synchronous) | `db/client.ts` | Not needed; PostgreSQL does this itself. |
| `PRAGMA foreign_keys` / `foreign_key_check` around migrations | `db/migrations.ts` | Not needed: PostgreSQL alters tables in place instead of rebuilding them. |
| `PRAGMA data_version` for the Transacciones ETag | `routes/transactions.ts` | It notices writes made by other programs on the file. Replace it with a counter that `publishChange` increments, or drop it. |
| `SQLITE_CONSTRAINT_UNIQUE` | `isUniqueViolation` in `routes/contracts.ts` | PostgreSQL's code is `23505`. |
| `CAST(substr(code, N) AS INTEGER)` | `nextContractCode` in `routes/contracts.ts` | SQLite reads `"011-A1"` as 11; PostgreSQL stops with an error. Only take codes that are all digits (`~ '^[0-9]+$'`) before casting. |
| `LIKE` | contract and adenda codes in `routes/contracts.ts`; voided-this-month in `routes/dashboard.ts` | PostgreSQL's `LIKE` is case-sensitive. These three are fine (codes are upper case, dates are digits), as long as dates stay text (section 7). |
| `SUM(` and `COUNT(` | 27 in 9 route files | node-postgres returns their results as **text** (`"12500"`), so adding them up would join strings. Cast in SQL (`::integer`, or `::bigint` and `Number()`), or use Drizzle's `.mapWith(Number)`. |
| `MAX(` used to allocate the next number | `routes/receipts.ts`, `routes/constancias.ts`, `routes/contracts.ts` (the one in `routes/dashboard.ts` reads a date and is fine) | See section 5. |
| `CURRENT_TIMESTAMP` as the default `created_at` | `timestamp()` in `db/schema.ts` | SQLite writes `2026-10-29 01:23:45`; PostgreSQL would write a different text form into a text column. The ledger reads these strings back to order payments (`parseTimestamp` in `lib/ledger.ts`), so set the default explicitly to the same format. |

## 7. The schema

- **Dates stay text** (`YYYY-MM-DD`, ISO timestamps). The whole app compares
  them as strings; changing their type is a separate project.
- **Money in cents** is `integer` today. PostgreSQL's `integer` stops at
  2,147,483,647 cents (L 21.4 million). Use `bigint` for every `*_cents`
  column, read back as numbers.
- `enabled` (`integer` in boolean mode) becomes `boolean`.
- `area_m2` (`real`) becomes `doublePrecision`.
- Unique indexes carry over unchanged.
- Sorting text (customer and user names, codes) uses the database's locale
  in PostgreSQL, not byte order as in SQLite, so accented names may sort
  differently. Use `COLLATE "C"` where the order must stay exactly the same.

**Migrations.** Do not port the 26 SQLite migrations one by one. Generate one
fresh PostgreSQL baseline from the new `schema.ts`
(`drizzle-kit generate` with `dialect: "postgresql"` in
`backend/drizzle.config.ts`). The old folder stays in git history.

## 8. Tests

`createTestApp()` in `backend/test/helpers.ts` gives every test its own
in-memory SQLite database, which is why 51 test files run in seconds. To keep
that speed, use **PGlite** (PostgreSQL compiled to run inside Node, supported by
Drizzle as `drizzle-orm/pglite`) for the tests, and a real PostgreSQL in the
browser tests and the CI workflows. Add the "two requests at once" tests from
section 5 against a real PostgreSQL, since PGlite has only one connection.

`backend/test/migrations.test.ts` and `backend/test/backup.test.ts` test the
SQLite migrator and snapshot, and are rewritten rather than ported.

## 9. Server, backups and deploy

- **Memory and cost.** The droplet has 512 MB, shared with the weight
  software. A small PostgreSQL needs roughly 50 to 100 MB more. DigitalOcean's
  smallest managed PostgreSQL costs more on its own than the whole $13 monthly
  budget. Decide this before anything else.
- **Backups.** `backend/scripts/backup.mjs` (`VACUUM INTO` and `quick_check`)
  and `deploy/lindero-backup.service` become a `pg_dump` with a restore test.
- **Deploy.** `deploy/update-from-build.sh` checks that the better-sqlite3
  native module loads. It would check the database connection instead.
- **Runbooks.** `docs/deployment-shared-droplet.md` and `docs/deployment.md`
  (`DATABASE_PATH`, the backup steps).

## 10. Moving the data, when the day comes

1. Write a copy script: read every table from the SQLite file and insert it
   into PostgreSQL, parents before children (users, projects, lots, customers,
   contracts, then payments, receipts and the rest).
2. Check the copy: the same row count in every table, and the same paid total,
   balance and mora for every contract, compared through the API on both.
3. Rehearse on a copy of last night's backup until step 2 passes twice in a
   row.
4. On the day: stop the app, take a final backup, copy, check, switch
   `DATABASE_URL`, start. Keep the SQLite file untouched: switching back is
   changing one setting.

## 11. Order of work

1. Decide where PostgreSQL runs and what it costs (section 9).
2. Section 5's "two requests at once" tests, against SQLite first. They pass
   there today, and must still pass after.
3. Make the data layer async while still on SQLite (section 4). This is the
   bulk of the work, and every existing test checks it.
4. Swap the driver, the schema and the SQLite-only spots (sections 6 and 7),
   with the locks from section 5.
5. Tests on PGlite and PostgreSQL (section 8).
6. Backups and deploy (section 9), then the data move (section 10).

One pull request per step, as for any other change.
