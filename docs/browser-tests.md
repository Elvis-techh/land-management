# Browser tests

The backend and frontend tests (`npm test`) check the rules: how a balance is
worked out, who may change what. They never open the app. The browser tests do:
a real Chrome logs in with the demo accounts and clicks through Lindero the way
a person would, on a desktop-sized screen and again on a phone-sized one.

## What they check

| File | What it does |
|---|---|
| `e2e/login.spec.ts` | A wrong password is refused; the supervisor logs in, stays in after a reload, and logs out; an associate does not see Permisos or Usuarios. |
| `e2e/screens.spec.ts` | Every screen in the menu opens and shows its content. |
| `e2e/sale.spec.ts` | A whole sale: new customer → new lot → credit contract → the lot shows *Financiado* with the customer → the prima is paid and appears in Recibos. |

Every test also fails if the page crashes or the server answers any request
with an error (5xx), even when the screen happened to look right
(`watchForBreakage` in `e2e/helpers.ts`).

## Running them

They run by themselves on every pull request (the **Browser tests** check). On
the laptop:

```bash
npx playwright install chromium   # once, to download the Chrome they use
npm run test:e2e                  # run them all
npm run test:e2e:ui               # watch them run, step by step
```

Playwright starts its own backend on port 3100, with a fresh copy of the demo
data each run, and Vite on port 5174. A dev server on 3000/5173 can keep running
meanwhile, and its database is never touched.

When one fails, the run's page on GitHub has a **browser-test-report** to
download, with a screenshot and a recording of every step (`npx playwright
show-report` opens it).

## Adding one

- Make the data the test needs, with a name of its own (`uniqueTag()`), rather
  than relying on a demo record: the same test runs twice per run (desktop,
  phone) against one database.
- Find things the way a person would: by the label or the button text
  (`getByLabel("Monto *")`, `getByRole("button", { name: "Crear lote" })`).
- Check what a person would check (the lot now names the customer), not exact
  totals: the demo data is dated relative to today, so amounts due move.
