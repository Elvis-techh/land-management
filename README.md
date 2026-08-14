# Lindero

Lindero is a land inventory and receivables platform for managing projects,
lots, customers, contracts, payments, balances, and receipts from one reliable
transactional record.

## Repository layout

```text
.
├── frontend/   Responsive web application and current UI prototype
├── backend/    HTTP API and server-side business rules
└── docs/       Product and architecture decisions
```

## Recommended stack

- Frontend: TypeScript, React, Vite, and a responsive PWA shell
- Backend: TypeScript, Node.js, and Fastify
- Database: PostgreSQL with migrations (Prisma or Drizzle will be selected when
  the first schema is implemented)
- Mobile: responsive PWA first; Capacitor later only if native app-store
  distribution or device APIs are required

Using TypeScript on both sides reduces context switching and allows API/domain
types to be shared. The browser provides the broadest Windows, Linux, Android,
and iOS compatibility without maintaining separate desktop applications.

## Current state

The original mockup is preserved as `frontend/index.html` and remains runnable.
It is a visual prototype with hard-coded data, not yet a production application.
The backend currently provides a minimal health endpoint so the server boundary
is explicit from the start.

## Local development

Requirements: Node.js 22+ and npm.

```bash
npm install
npm run dev:frontend
```

In a second terminal:

```bash
npm run dev:backend
```

- Frontend: `http://localhost:5173`
- Backend health check: `http://localhost:3000/api/health`

See [docs/architecture.md](docs/architecture.md) before implementing financial
features. Monetary values and status transitions have important invariants.

