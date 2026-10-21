import type { Page } from "@playwright/test";

import { expect, goTo, logIn, test } from "./helpers";

/*
 * «Estado de su cuenta» on the receipt (Paso 3): the next cuota, how many are
 * paid, and whether the lot is up to date. And the receipt still prints on one
 * sheet of A4 with it, for one lot and for three, the most the box covers.
 */

async function receiptFor(page: Page, customer: string, amount: string, split: boolean) {
  const dialog = page.getByRole("dialog");

  await goTo(page, "Recibos");
  await page.getByRole("banner").getByRole("button", { name: "Nueva transacción" }).click();
  await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill(customer);
  await dialog.getByRole("option", { name: new RegExp(customer) }).first().click();
  await dialog.getByLabel("Monto *").fill(amount);
  if (split) {
    await dialog.getByRole("button", { name: "Repartir el monto entre los lotes" }).click();
    await expect(dialog.locator(".after-payment")).toHaveCount(3);
  }
  await dialog.getByRole("button", { name: "Registrar y emitir recibo" }).click();
  await expect(dialog).toHaveCount(0);
}

/** The receipt on screen, printed to PDF: how many sheets of A4 it takes. */
async function printedPages(page: Page): Promise<number> {
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });

  return pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;
}

test("the receipt says where the account stands, and still prints on one page", async ({ page }, testInfo) => {
  await logIn(page);
  await receiptFor(page, "José Rodríguez", "100", false);

  const paper = page.locator(".receipts-layout .receipt-paper").first();
  const status = paper.locator(".receipt-status");
  await expect(status).toContainText("ESTADO DE SU CUENTA AL");
  await expect(status.locator(".receipt-status-row")).toHaveCount(1);
  await expect(status).toContainText("PRÓXIMA CUOTA");
  await expect(status).toContainText(/\d+ de \d+/);
  await expect(status.locator(".receipt-status-badge")).toHaveText(/Al día|Adelantado|Atrasado|Pagado/);

  if (testInfo.project.name === "desktop") {
    expect(await printedPages(page)).toBe(1);
  }
});

test("a receipt for three lots has a row for each, and prints on one page", async ({ page }, testInfo) => {
  await logIn(page);
  await receiptFor(page, "Ana Lucía Paz", "30000", true);

  const status = page.locator(".receipts-layout .receipt-paper").first().locator(".receipt-status");
  await expect(status.locator(".receipt-status-row")).toHaveCount(3);
  // Each row names its lot, so three «Próxima cuota» can be told apart.
  await expect(status.locator(".receipt-status-key", { hasText: /PRÓXIMA CUOTA · / })).toHaveCount(3);

  if (testInfo.project.name === "desktop") {
    expect(await printedPages(page)).toBe(1);
  }
});
