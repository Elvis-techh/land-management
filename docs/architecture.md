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
  persisted transaction rate; the current mockup's hard-coded conversion is only
  visual behavior.

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

- Server-side authorization for every write and sensitive read
- Password hashing or a managed identity provider; never custom plaintext auth
- Append-only audit events for financial and lifecycle changes
- Database backups plus tested restore procedures
- Idempotency keys for payment creation and offline retries
- Generated receipts linked to an immutable payment snapshot
- Automated tests around money, conversion, balance, status, and transitions

