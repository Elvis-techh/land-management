import { expect, goTo, logIn, test } from "./helpers";

/*
 * Under each lot in «Registrar un pago», a "después:" line says what the amount
 * being typed will do, in the receipt's own words, and follows the amount as it
 * changes.
 */
test("the form says what the amount being typed will do", async ({ page }) => {
  const dialog = page.getByRole("dialog");
  const after = dialog.locator(".after-payment");

  await logIn(page);
  await goTo(page, "Recibos");
  await page.getByRole("banner").getByRole("button", { name: "Nueva transacción" }).click();
  await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill("José Rodríguez");
  await dialog.getByRole("option", { name: /José Rodríguez/ }).click();

  // Nothing typed yet, nothing to say.
  await expect(after).toHaveCount(0);

  const balanceText = await dialog.locator(".split-table .is-balance").first().innerText();
  const balance = balanceText.replace(/^\s*L\.\s*/, "").replace(/,/g, "");

  await dialog.getByLabel("Monto *").fill(balance);
  await expect(after).toContainText("contrato pagado");

  await dialog.getByLabel("Monto *").fill("1");
  await expect(after).toContainText("Abono a cuota");
  await expect(after).not.toContainText("contrato pagado");
});
