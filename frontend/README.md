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
├── main.tsx           Entry point. Mounts React into index.html.
├── App.tsx            App shell: sidebar, top bar, and which screen shows.
├── types.ts           Shared domain types.
├── styles.css         The design.
├── lib/               Shared helpers. money.ts is the one way money is
│                      typed, shown and converted to centavos.
├── components/        Reusable pieces: dialogs, search box, menus, banners.
└── features/          One folder per screen or business feature:
                       dashboard (Panel general), projects, lots, contracts,
                       customers, receipts, constancias, audit (Historial),
                       permissions, users, settings (Configuración), rate
                       (the lempira/dollar rate) and auth (log in).
```

New features get their own folder under `features/`. Files are grouped by what
they do for the business, not by file type. Tests for the logic that has no
screen (`lib/` and the presentation helpers) live in `test/`; the screens
themselves are tested in a real browser from `e2e/` at the repository root.

## Where the numbers come from

Every figure on screen comes from the backend. The frontend never decides a
balance, a lot's status, a receipt number or whether a customer is late; it
shows what the server worked out. See `docs/architecture.md`.

## The prototype

The original single-file mockup is kept at `docs/prototype/index.html` for
history. Every screen it showed is now built for real, so it is no longer the
reference for anything. It also did things Lindero must not: it let users type
a lot's status and a paid amount, and made receipt numbers in the browser.
