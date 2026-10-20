import { expect, goTo, logIn, test } from "./helpers";

/*
 * «Repartir» on a receipt that has centavos.
 *
 * The amounts in that dialog are typed in lempiras, and it used to add them up
 * as if they were centavos: an amount like 333.50 crashed the screen the moment
 * it opened ("Money must be a whole number of centavos"), and a round one came
 * out a hundred times too small, so the total never matched the receipt.
 */
test("«Repartir» moves money with centavos from one lot to another", async ({ page }) => {
  const dialog = page.getByRole("dialog");

  await logIn(page);
  await goTo(page, "Recibos");
  await page.getByRole("banner").getByRole("button", { name: "Nueva transacción" }).click();
  await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill("Ana Lucía Paz");
  await dialog.getByRole("option", { name: /Ana Lucía Paz/ }).click();
  await dialog.getByLabel("Monto *").fill("1000.50");
  // The proposed split puts it all on the lot whose cuota is due first, C-02.
  await dialog.getByRole("button", { name: "Repartir el monto entre los lotes" }).click();
  await expect(dialog.locator(".split-table tbody tr")).toHaveCount(3);
  await dialog.getByRole("button", { name: "Registrar y emitir recibo" }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByRole("button", { name: "Repartir", exact: true }).click();
  await expect(dialog.getByText("Repartir entre lotes")).toBeVisible();
  await expect(dialog.locator(".redistribute-total")).toContainText("Repartido L. 1,000.5 de L. 1,000.5");

  // Half of it onto C-08: 500.25 + 500.25.
  const amounts = dialog.locator(".redistribute-amount input");
  await amounts.nth(0).fill("500.25");
  await expect(dialog.locator(".redistribute-gap")).toContainText("Faltan L. 500.25");
  await amounts.nth(1).fill("500.25");
  await expect(dialog.locator(".redistribute-total")).toContainText("Repartido L. 1,000.5 de L. 1,000.5");
  await expect(dialog.locator(".redistribute-gap")).toHaveCount(0);

  await dialog.getByLabel("Motivo *").fill("La mitad de la prima era del lote C-08.");
  await dialog.getByRole("button", { name: "Repartir", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  const paper = page.locator(".receipt-paper:visible").first();
  await expect(paper).toContainText("C-08");
  await expect(paper).toContainText("500.25");
  await expect(paper).toContainText("1,000.50");
});
