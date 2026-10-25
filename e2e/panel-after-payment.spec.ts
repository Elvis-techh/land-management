import { expect, goTo, logIn, screen, test } from "./helpers";

/*
 * The Panel counts a payment the moment its receipt is issued, without a
 * reload. Another person's payment already reached it through the live
 * updates; one's own did not, because this tab skips its own write's event
 * and the receipt's handler re-read every list except the Panel.
 */
const lempiras = (shown: string) => Number(shown.replace(/^L\.\s*/, "").replace(/[^\d.]/g, ""));

test("the Panel counts a payment as soon as its receipt is issued", async ({ page }) => {
  const dialog = page.getByRole("dialog");
  const collected = screen(page).locator(".dash-hero-value");

  await logIn(page);
  await goTo(page, "Panel general");
  await expect(collected).toBeVisible();
  const before = lempiras(await collected.innerText());

  await goTo(page, "Recibos");
  await page.getByRole("banner").getByRole("button", { name: "Nueva transacción" }).click();
  await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill("José Rodríguez");
  await dialog.getByRole("option", { name: /José Rodríguez/ }).click();
  await dialog.getByLabel("Monto *").fill("1000");
  await dialog.getByRole("button", { name: "Registrar y emitir recibo" }).click();
  await expect(dialog).toHaveCount(0);

  // On a phone the receipt just issued fills the screen, over the menu button.
  const back = screen(page).locator(".receipt-sheet-back");
  if (await back.isVisible()) {
    await back.click();
  }

  await goTo(page, "Panel general");
  await expect.poll(async () => lempiras(await collected.innerText())).toBe(before + 1_000);
});
