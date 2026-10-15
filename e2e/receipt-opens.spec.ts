import { expect, goTo, logIn, test } from "./helpers";

/*
 * Saving a payment opens the receipt it issued, so it can be checked, printed
 * or sent straight away, instead of leaving it to be found in the list.
 */
test("the receipt opens as soon as a payment is saved", async ({ page }) => {
  const dialog = page.getByRole("dialog");

  await logIn(page);
  await goTo(page, "Recibos");
  await page.getByRole("banner").getByRole("button", { name: "Nueva transacción" }).click();
  await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill("José Rodríguez");
  await dialog.getByRole("option", { name: /José Rodríguez/ }).click();
  await dialog.getByLabel("Monto *").fill("1000");
  await dialog.getByRole("button", { name: "Registrar y emitir recibo" }).click();
  await expect(dialog).toHaveCount(0);

  // The first copy: the second is the offscreen one the WhatsApp image is drawn from.
  const paper = page.locator(".receipt-paper:visible").first();
  await expect(paper).toContainText("RECIBO DE PAGO");
  await expect(paper).toContainText("José Rodríguez");
  await expect(paper).toContainText("1,000.00");
});
