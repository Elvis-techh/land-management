# Lindero backend

The backend owns all financial calculations and lifecycle rules. The frontend
must never be the authority for balances, lot state, receipt numbering, exchange
rates, or payment-health status.

Initial source layout:

```text
src/
├── config/       Validated runtime configuration
├── routes/       HTTP transport layer
├── modules/      Business modules added feature by feature
└── server.ts     Process entry point
```

As modules are implemented, each should contain its application service, domain
rules, repository interface, HTTP schema, and tests together. This keeps changes
to contracts or payments localized instead of spreading financial logic across
controllers and UI code.

