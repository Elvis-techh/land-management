# Lindero backend

The backend owns all financial calculations and lifecycle rules. The frontend
must never be the authority for balances, lot state, receipt numbering, exchange
rates, or payment-health status.

## Running it

From the project root:

```bash
npm run db:migrate     # create or update the database file
npm run db:seed        # fictional demo data (refuses in production)
npm run dev:backend    # http://localhost:3000/api/health
```

Settings come from `backend/.env` when it exists; `.env.example` lists every
one, with what it is for. The defaults work for local development.

## Layout

```text
src/
├── server.ts     Process entry point. Runs pending migrations, then listens.
├── app.ts        Builds the Fastify app: plugins, rate limits, routes.
├── config/       Validated runtime configuration (env.ts).
├── auth/         Sessions and the login check on every request.
├── routes/       HTTP layer: one file per area (lots, contracts, receipts,
│                 transactions, mora, settings, audit…). Validates input,
│                 calls lib/, answers.
├── lib/          The business rules, kept free of HTTP: the ledger that
│                 replays a contract's payments in date order, receipts,
│                 mora, contract lifecycle, permissions, Historial entries.
└── db/           Schema (Drizzle), migrations, demo seed and first-account
                  bootstrap.
test/             One test file per rule or route (`npm test`).
drizzle/          The SQL migrations, generated from db/schema.ts.
scripts/          Backups, the benchmark, and a build helper.
```

A change to how money is counted belongs in `lib/`, with a test in `test/`
that fails without it. Routes stay thin, so the same rule answers the same way
on every screen.
