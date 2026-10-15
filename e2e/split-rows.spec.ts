import { expect, goTo, logIn, test } from "./helpers";

/*
 * Each lot's line in «Registrar un pago», for a customer with several lots.
 *
 * On a phone the amount field used to share a line with the balance and sat on
 * top of the "próxima … · adelanto …" under it. The balance now has its own
 * line, with the amount and the type side by side below it. And the two fields
 * look like every other field in the app rather than the browser's own box.
 */
test("each lot shows its balance whole, with the amount and type below it", async ({ page }, testInfo) => {
  const dialog = page.getByRole("dialog");

  await logIn(page);
  await goTo(page, "Recibos");
  await page.getByRole("banner").getByRole("button", { name: "Nueva transacción" }).click();
  await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill("Ana Lucía Paz");
  await dialog.getByRole("option", { name: /Ana Lucía Paz/ }).click();
  await dialog.getByLabel("Monto *").fill("30000");
  await dialog.getByRole("button", { name: "Repartir el monto entre los lotes" }).click();

  const rows = dialog.locator(".split-table tbody tr");
  await expect(rows).toHaveCount(3);
  // Each lot's "después:" line arrives a moment after the split and adds a line
  // to the row; measure once it is there, not while the row is still growing.
  await expect(dialog.locator(".after-payment")).toHaveCount(3);

  for (const row of await rows.all()) {
    const amount = row.locator(".col-receive input");
    const type = row.locator(".col-type select");

    // The app's own field style, not the browser default.
    await expect(amount).toHaveCSS("border-radius", "8px");
    await expect(type).toHaveCSS("border-radius", "8px");

    if (testInfo.project.name === "phone") {
      const balance = (await row.locator("td").nth(1).boundingBox())!;
      const amountBox = (await amount.boundingBox())!;
      const typeBox = (await type.boundingBox())!;

      expect(balance.y + balance.height, "the amount covers the balance line").toBeLessThanOrEqual(
        amountBox.y + 1,
      );
      expect(Math.abs(amountBox.y - typeBox.y), "amount and type are not side by side").toBeLessThan(2);
      expect(amountBox.x + amountBox.width, "amount and type overlap").toBeLessThanOrEqual(typeBox.x);
    }
  }
});
