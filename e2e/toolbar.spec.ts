import { expect, goTo, logIn, test } from "./helpers";

/*
 * #4: the toolbars' buttons look like buttons, and the search box can be
 * emptied in one tap. Checked on Contratos, Clientes, Recibos and Lotes, which
 * share the same SearchBox and the same button look.
 */
const screens = [
  { tab: "Contratos", search: "Buscar contrato" },
  { tab: "Clientes", search: "Buscar cliente" },
  { tab: "Recibos", search: "Buscar transacciones" },
  { tab: "Lotes", search: "Buscar lote" },
] as const;

for (const { tab, search } of screens) {
  test(`${tab}: the search box empties with one tap on «×»`, async ({ page }) => {
    await logIn(page);
    await goTo(page, tab);

    const box = page.getByRole("searchbox", { name: search });
    const clear = page.getByRole("button", { name: "Borrar la búsqueda" });
    await expect(clear).toHaveCount(0);

    await box.fill("zzz");
    await expect(clear).toBeVisible();
    await clear.click();

    await expect(box).toHaveValue("");
    await expect(box).toBeFocused();
    await expect(clear).toHaveCount(0);
  });
}

test("the toolbar's buttons are filled, unlike the white search box", async ({ page }) => {
  await logIn(page);
  await goTo(page, "Clientes");

  const background = (selector: string) =>
    page.locator(selector).first().evaluate((element) => getComputedStyle(element).backgroundColor);

  const searchBackground = await background(".lots-toolbar .table-search");
  const buttonBackground = await background(".lots-toolbar .menu-trigger:not(.active)");
  expect(searchBackground).toBe("rgb(255, 255, 255)");
  expect(buttonBackground).not.toBe(searchBackground);
  expect(buttonBackground).not.toBe("rgba(0, 0, 0, 0)");
});

/*
 * #3: Ctrl+F jumps to the screen's own search box. A keyboard shortcut, so only
 * on the computer-sized run.
 */
test.describe("Ctrl+F", () => {
  test.skip(({ isMobile }) => isMobile, "a keyboard shortcut");

  /** Whether the page kept the browser's own search from opening. */
  async function pressFind(page: import("@playwright/test").Page): Promise<boolean> {
    await page.evaluate(() => {
      // The F, not the Ctrl pressed before it. Bubbles here after the page's
      // own listener on document has had its say.
      const onKey = (event: KeyboardEvent) => {
        if (event.key.toLowerCase() === "f") {
          (window as unknown as { lastFind: boolean }).lastFind = event.defaultPrevented;
          window.removeEventListener("keydown", onKey);
        }
      };
      window.addEventListener("keydown", onKey);
    });
    await page.keyboard.press("Control+f");
    return page.evaluate(() => (window as unknown as { lastFind: boolean }).lastFind);
  }

  test("jumps to the search box and selects what is in it; again opens the browser's search", async ({ page }) => {
    await logIn(page);
    await goTo(page, "Contratos");

    const box = page.getByRole("searchbox", { name: "Buscar contrato" });
    await box.fill("Carlos");
    await page.locator("body").click({ position: { x: 5, y: 300 } });
    await expect(box).not.toBeFocused();

    expect(await pressFind(page)).toBe(true);
    await expect(box).toBeFocused();
    // Selected, so typing replaces the old search.
    await page.keyboard.type("Elena");
    await expect(box).toHaveValue("Elena");

    // Already in the box: the browser's own search is let through.
    expect(await pressFind(page)).toBe(false);
  });

  test("leaves a screen without a search box alone", async ({ page }) => {
    await logIn(page);
    await goTo(page, "Panel general");
    expect(await pressFind(page)).toBe(false);
  });

  test("does not reach behind an open window", async ({ page }) => {
    await logIn(page);
    await goTo(page, "Contratos");
    await page.getByRole("banner").getByRole("button", { name: "Nuevo contrato" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    expect(await pressFind(page)).toBe(false);
    await expect(page.getByRole("searchbox", { name: "Buscar contrato" })).not.toBeFocused();
  });
});

/* #5: Lotes has a search box like the other lists. */
test("Lotes: the search narrows the list, and says so when nothing matches", async ({ page }) => {
  await logIn(page);
  await goTo(page, "Lotes");

  const box = page.getByRole("searchbox", { name: "Buscar lote" });
  const count = page.locator(".result-count");
  const before = await count.textContent();

  await box.fill("B-14");
  await expect(page.locator(".code-badge", { hasText: "B-14" })).toBeVisible();
  await expect(count).not.toHaveText(before!);
  await expect(page.locator("tbody .code-badge")).toHaveCount(1);

  await box.fill("zzz no existe");
  await expect(page.getByText("Ningún lote coincide con «zzz no existe».")).toBeVisible();
});
