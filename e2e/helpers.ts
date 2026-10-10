import { test as base, expect, type Page } from "@playwright/test";

export { expect };

/** The demo accounts `db:seed` creates (backend/src/db/seed.ts). */
export const accounts = {
  owner: { email: "gerencia@lindero.hn", password: "lindero123", name: "Gerencia" },
  staff: { email: "asociado@lindero.hn", password: "asociado123", name: "Asociado" },
} as const;

export async function logIn(page: Page, account: { email: string; password: string } = accounts.owner) {
  await page.goto("/");
  await page.getByLabel("Correo").fill(account.email);
  await page.getByLabel("Contraseña").fill(account.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("banner")).toBeVisible();
}

/** Open the side menu if it is hidden. */
export async function showMenu(page: Page) {
  const openMenu = page.getByRole("banner").getByRole("button", { name: "Abrir menú" });
  if (await openMenu.isVisible()) {
    await openMenu.click();
  }
}

/**
 * Open a screen from the side menu. The menu hides itself after a click
 * elsewhere (see CLOSE_ON_OUTSIDE_CLICK_ON_DESKTOP in App.tsx) and after every
 * choice on a phone; "Abrir menú" shows exactly while it is hidden.
 */
export async function goTo(page: Page, tab: string) {
  await showMenu(page);
  await page.getByRole("navigation").getByRole("button", { name: tab, exact: true }).click();
  await expect(page.getByRole("banner")).toContainText(tab);
}

/**
 * `test` with one extra rule for every browser test: the page must not crash
 * (an uncaught error in the browser) and the server must not answer any /api
 * request with a 5xx. Either one fails the test even when the screen happened
 * to look right.
 */
export const test = base.extend<{ watchForBreakage: void }>({
  watchForBreakage: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on("pageerror", (error) => problems.push(`Browser error: ${error.message}`));
      page.on("response", (response) => {
        if (response.url().includes("/api/") && response.status() >= 500) {
          problems.push(`Server error ${response.status()} on ${response.request().method()} ${response.url()}`);
        }
      });
      await use();
      expect(problems, "the page crashed or the server failed while the test ran").toEqual([]);
    },
    { auto: true },
  ],
});

/** A short tag that makes the names a test creates its own, run after run. */
export function uniqueTag() {
  return Date.now().toString(36).slice(-5).toUpperCase();
}

/** The area below the top bar where the open screen draws itself. */
export const screen = (page: Page) => page.locator(".content");
