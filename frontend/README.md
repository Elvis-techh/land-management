# Lindero frontend

`index.html` is the renamed and preserved MVP mockup. Vite serves it directly,
so the existing design can be reviewed while it is migrated incrementally.

## Intended frontend architecture

The production frontend should use React and TypeScript, organized by business
feature rather than by generic file type:

```text
src/
├── app/          Router, providers, layouts, and global configuration
├── features/     projects, lots, customers, contracts, payments, receipts
├── components/   Reusable presentation components
├── services/     Typed API client
├── styles/       Design tokens and global styles
└── test/         Shared test setup
```

The migration should begin after the API contract and initial database model are
agreed. Until then, the mockup is the UI reference, not a source of business
truth.

