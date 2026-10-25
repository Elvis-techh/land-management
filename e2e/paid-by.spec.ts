import type { Page } from "@playwright/test";

import { expect, goTo, logIn, screen, test, uniqueTag } from "./helpers";

/*
 * «Pagado por», end to end: somebody else pays for a customer's lot and gets
 * the receipt in their own name. The next payment for the same customer offers
 * that name again, and a receipt already issued can be put back in the
 * customer's name, with a reason.
 *
 * The customer, lot and contract are the test's own, made through the API.
 */

/** A customer with a financed contract and nothing paid yet. */
async function customerWithContract(page: Page) {
  const tag = uniqueTag();
  const customer = `Titular ${tag}`;
  const lotCode = `P-${String((parseInt(tag, 36) % 9000) + 1000)}`;
  const today = new Date().toISOString().slice(0, 10);

  const post = async (url: string, data: unknown) => {
    const response = await page.request.post(url, { data });
    expect(response.status(), await response.text()).toBe(201);
    return response.json();
  };

  const { customer: created } = await post("/api/customers", {
    fullName: customer,
    customerSince: Number(today.slice(0, 4)),
  });
  const { lot } = await post("/api/lots", {
    code: lotCode,
    projectName: "Valle Verde",
    areaM2: 300,
    basePriceCents: 13_500_000,
  });
  await post("/api/contracts", {
    customerId: created.id,
    lotId: lot.id,
    kind: "contract",
    saleType: "financed",
    salePriceCents: 13_500_000,
    downPaymentCents: 1_500_000,
    termMonths: 12,
    monthlyPaymentCents: 1_000_000,
    dueDay: 5,
    signedOn: today,
    firstDueOn: today,
  });

  return customer;
}

test("a receipt in the payer's name, offered again next time, and put back", async ({ page }, testInfo) => {
  const dialog = page.getByRole("dialog");
  const payer = "Carlos Mejía";

  await logIn(page);
  const customer = await customerWithContract(page);

  // Already on Recibos after the first payment, so only the first goes there.
  // On a phone the receipt just issued fills the screen, over the top bar.
  const openPayment = async () => {
    const back = screen(page).locator(".receipt-sheet-back");
    if (await back.isVisible()) {
      await back.click();
    }
    await page.getByRole("button", { name: "Nueva transacción" }).click();
    await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill(customer);
    await dialog.getByRole("option", { name: new RegExp(customer) }).click();
  };

  // The payment: the payer's name, and what it does, said where it is typed.
  await goTo(page, "Recibos");
  await openPayment();
  await expect(dialog.getByLabel("Pagado por (opcional)")).toHaveValue("");
  await dialog.getByLabel("Monto *").fill("15000");
  await dialog.getByLabel("Pagado por (opcional)").fill(payer);
  await expect(dialog).toContainText(
    `El recibo sale a nombre de ${payer}; el lote y el saldo siguen siendo de ${customer}.`,
  );
  await dialog.getByLabel("Pagado por (opcional)").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("pagado-por-formulario.png") });
  await dialog.getByRole("button", { name: "Registrar y emitir recibo" }).click();
  await expect(dialog).toHaveCount(0);

  // The receipt names the payer, and the customer on one line under it.
  const paper = page.locator(".receipt-paper:visible").first();
  await expect(paper.locator(".receipt-client")).toContainText("PAGADO POR");
  await expect(paper.locator(".receipt-client-name")).toHaveText(payer);
  await expect(paper.locator(".receipt-client")).toContainText(
    `A cuenta de ${customer}, titular del contrato`,
  );
  await paper.screenshot({ path: testInfo.outputPath("pagado-por-recibo.png") });

  // Still one sheet when printed.
  const pdf = await page.pdf({ format: "A4" });
  expect(pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g)?.length).toBe(1);

  // Put back in the customer's name, with a reason.
  await page.getByRole("button", { name: "Pagado por", exact: true }).click();
  await expect(dialog.getByLabel("Pagado por")).toHaveValue(payer);
  await dialog.getByLabel("Pagado por").fill("");
  await dialog.getByLabel("Motivo *").fill("Se puso por error en este recibo.");
  await dialog.screenshot({ path: testInfo.outputPath("pagado-por-cambiar.png") });
  await dialog.getByRole("button", { name: "Guardar" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(paper.locator(".receipt-client")).toContainText("CLIENTE");
  await expect(paper.locator(".receipt-client-name")).toHaveText(customer);

  // That receipt is the customer's own again, so the next payment offers no payer...
  await openPayment();
  await expect(dialog.getByLabel("Monto *")).toBeVisible();
  await expect(dialog.getByLabel("Pagado por (opcional)")).toHaveValue("");
  await dialog.getByLabel("Monto *").fill("1000");
  await dialog.getByLabel("Pagado por (opcional)").fill(payer);
  await dialog.getByRole("button", { name: "Registrar y emitir recibo" }).click();
  await expect(dialog).toHaveCount(0);

  // ...while after a receipt in the payer's name, the next one offers it.
  await openPayment();
  await expect(dialog.getByLabel("Pagado por (opcional)")).toHaveValue(payer);
  await expect(dialog).toContainText("Del último recibo de este cliente.");
});
