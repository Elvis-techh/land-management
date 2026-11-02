import { expect, goTo, logIn, test } from "./helpers";

/*
 * #4: the toolbars' buttons look like buttons, and the search box can be
 * emptied in one tap. Checked on Contratos, Clientes and Recibos, which share
 * the same SearchBox and the same button look.
 */
const screens = [
  { tab: "Contratos", search: "Buscar contrato" },
  { tab: "Clientes", search: "Buscar cliente" },
  { tab: "Recibos", search: "Buscar transacciones" },
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
