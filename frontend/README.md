# Lindero frontend

React + TypeScript, built and served by Vite.

## Running it

From the project root:

```bash
npm run dev:frontend     # http://localhost:5173
```

Vite watches your files. Save a change and the browser updates instantly — no
manual refresh, and you keep whatever you had on screen.

To open Lindero on your real phone, use the "Network" URL that `npm run dev`
prints (both devices must be on the same WiFi).

## Checking your work

```bash
npm run typecheck --workspace @lindero/frontend   # TypeScript errors only
npm run build --workspace @lindero/frontend       # typecheck + production build
```

`npm run build` produces `dist/`, which is what Nginx serves in production.
There is no packaging or installer step — Lindero is a website, not a desktop
app.

## Layout

```text
src/
├── main.tsx                  Entry point. Mounts React into index.html.
├── App.tsx                   App shell: sidebar, topbar, and which screen shows.
├── types.ts                  Shared domain types (Lot, LotStatus, TabId).
├── styles.css                The design. Ported unchanged from the prototype.
├── lib/
│   └── money.ts              Cents type + formatting. All money goes through here.
├── components/               Reusable pieces (Sidebar, Topbar, Icons).
└── features/
    └── lots/                 One folder per business feature.
        ├── LotsPage.tsx      The screen.
        └── lotsData.ts       Temporary seed data; replaced by the API next.
```

New features get their own folder under `features/`. Files are grouped by what
they do for the business, not by file type.

## Status

- **Lotes** — ported to React. Filter chips work. Data is still hard-coded seed
  data in `features/lots/lotsData.ts`.
- **Panel general, Contratos, Clientes, Recibos** — placeholders. Built one at a
  time, each all the way down to the database.

## The prototype

The original single-file mockup is frozen at `docs/prototype/index.html` and can
be opened directly in a browser. It is the **visual** reference for screens not
yet built.

It is not a reference for data: it let users type a lot's status, type a paid
amount, and generated receipt numbers in the browser. Lindero derives status
from contracts, derives balances from payments, and assigns receipt numbers on
the server. See `docs/architecture.md`.
