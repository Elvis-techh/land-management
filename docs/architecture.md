Terminal 1:

￼
npm run dev:backend
Wait for Server listening at http://...:3000

Terminal 2:

￼
npm run dev:frontend
Wait for Local: http://localhost:5173/



# Architecture decisions

## System shape

Lindero should begin as a modular monolith: one responsive frontend, one backend
API, and one PostgreSQL database. This is easier to deploy and audit than
microservices while preserving clear module boundaries for future growth.

```text
Responsive React/PWA frontend
            |
      HTTPS JSON API
            |
TypeScript/Fastify modular backend
            |
        PostgreSQL
```

Scheduled reminder workers and file storage can be added alongside the backend
when Phase 2 begins. They should not be separate services in the MVP.

## Core domain model

```text
Project 1 ── * Lot 1 ── * Contract * ── 1 Customer
                         |
                         * Payment 1 ── 1 Receipt
                         |
                         * PaymentScheduleItem
```

Supporting records will include exchange-rate evidence, payment adjustments,
users/roles, audit events, attachments, and reminder deliveries.

## Financial invariants

- Store money as integer minor units (`centavos`/`cents`), never floating-point
  numbers.
- A payment stores `original_amount`, `original_currency`, `exchange_rate`,
  `contract_currency_amount`, and the rate date/source.
- The contract balance is contract price minus posted payments plus posted
  adjustments. It is calculated by the backend.
- Posted payments are not silently edited or deleted. Reverse and replace them.
- Receipt numbers are assigned atomically by the database and are never reused.
- Currency conversion display toggles are estimates unless they reference a
  persisted transaction rate. The lempira/dollar rate shown in the header is
  refreshed from a market feed and can be overridden by a supervisor; it is
  display only. It is stored as an append-only history of readings, so an old
  figure can still be explained, and a manual rate is never overwritten by the
  scheduler until somebody asks for automatic updates again.
- The market feed quotes an indicative rate. It is neither the Banco Central's
  official rate nor what a bank pays out after its spread, which is why it may
  price a lot on screen but must never settle a payment.

## Measurement invariants

- Store area as square metres on the lot, never in the unit it was quoted in.
  Land here is sold by the manzana and the vara cuadrada as often as by the
  metre, so people must be able to work in those — but a comparison, a total or
  a price-per-unit across two lots stored in different units needs a conversion
  table to be trusted, which is the same trap as storing money as floats.
- The unit belongs to the PROJECT, not the lot: one project is sold in one unit,
  so it is chosen once and every lot in it is captured and displayed that way.
- Changing a project's unit rewrites nothing. It changes how the same land is
  written down, never how much of it there is.

## Status model

Keep three distinct concepts:

1. Contract lifecycle: draft, active, paid_off, cancelled, or defaulted.
2. Payment health: current, due_soon, overdue, or at_risk, calculated from the
   payment schedule and grace-period policy.
3. Lot availability: derived from active reservations/contracts and completed
   sales, not directly edited during normal operations.

Exact transitions, grace periods, reservation expiry, and default rules must be
agreed with the business before schema implementation.

## API boundaries

Organize backend code by domain module: projects, lots, customers, contracts,
payments, receipts, identity, audit, and notifications. Validate every write at
the API boundary, enforce invariants in application/domain services, and commit
financial changes inside database transactions.

## Frontend strategy

The current single-file prototype already demonstrates navigation, tables,
currency display, receipts, and mobile breakpoints. Production work should move
it into feature-based React components and consume typed API responses. Desktop
tables need explicit mobile alternatives (cards or prioritized columns) rather
than relying only on horizontal scrolling.

Use responsive web delivery first. Add PWA installability and a carefully scoped
offline queue only after conflict, receipt-number, and payment-sync behavior are
defined. Offline financial writes without those rules risk duplicates.

## Security and reliability baseline

- Server-side authorization for every write and sensitive read, asked of the
  database rather than a hard-coded table: a supervisor can change what the
  associate role may do, and a revoked capability has to stop working on that
  user's very next request, not at their next login
- Managing users and editing permissions can never be granted to another role.
  Without that lock, an associate could be given the power to grant themselves
  everything, including the account that would have to take it back
- Password hashing or a managed identity provider; never custom plaintext auth
- Append-only audit events for financial and lifecycle changes
- Database backups plus tested restore procedures
- Idempotency keys for payment creation and offline retries
- Generated receipts linked to an immutable payment snapshot
- Automated tests around money, conversion, balance, status, and transitions

