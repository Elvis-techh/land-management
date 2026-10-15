import { expect, goTo, logIn, test } from "./helpers";

/*
 * An amount that pays a lot off ahead of its schedule is a «Pago total», and
 * the form says so beside the Tipo. Anything less keeps the contract's own
 * type, and a type picked by hand is never changed.
 */
test("paying off the whole balance early is filed as a pago total", async ({ page }) => {
  const dialog = page.getByRole("dialog");
  const type = dialog.getByLabel("Tipo", { exact: true });
  const hint = dialog.getByText("se registra como «Pago total»");

  await logIn(page);
  await goTo(page, "Recibos");
  await page.getByRole("banner").getByRole("button", { name: "Nueva transacción" }).click();
  // The demo customer with one financed lot, part way through its cuotas.
  await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill("José Rodríguez");
  await dialog.getByRole("option", { name: /José Rodríguez/ }).click();

  const balanceText = await dialog.locator(".split-table .is-balance").first().innerText();
  // "L. 119,800" → "119800": the "L." prefix carries a dot of its own.
  const balance = balanceText.replace(/^\s*L\.\s*/, "").replace(/,/g, "");

  await dialog.getByLabel("Monto *").fill(balance);
  await expect(type).toHaveValue("full_payment");
  await expect(hint).toBeVisible();

  // Less than the balance: back to what the contract suggests, and no note.
  await dialog.getByLabel("Monto *").fill("1000");
  await expect(type).not.toHaveValue("full_payment");
  await expect(hint).toHaveCount(0);

  // Picked by hand, it stays put even when the amount would pay the lot off.
  await type.selectOption("adjustment");
  await dialog.getByLabel("Monto *").fill(balance);
  await expect(type).toHaveValue("adjustment");
  await expect(hint).toHaveCount(0);
});
