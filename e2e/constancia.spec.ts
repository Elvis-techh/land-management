import type { Page } from "@playwright/test";

import { expect, goTo, logIn, test, uniqueTag } from "./helpers";

/*
 * The whole life of a constancia de cancelación total: lots are paid off, the
 * supervisor issues the constancia from a contract — for one lot, or for
 * several together — and the office verifies it from the code printed at its
 * foot. The customers, lots and contracts are the tests' own, so paying them
 * off never disturbs the demo data.
 */

/** A fresh page: the receipt the last payment opened covers the screen on a phone. */
async function freshPage(page: Page) {
  await page.reload();
  await expect(page.getByRole("banner").first()).toBeVisible();
}

async function newCustomer(page: Page, name: string) {
  const dialog = page.getByRole("dialog");

  await goTo(page, "Clientes");
  await page.getByRole("banner").getByRole("button", { name: "Nuevo cliente" }).click();
  await dialog.getByLabel("Nombre completo").fill(name);
  await dialog.getByRole("button", { name: "Crear cliente" }).click();
  await expect(dialog).toHaveCount(0);
}

/** A L 150,000 lot in Valle Verde, sold to `customer` on credit. Returns the lot code. */
async function sellLot(page: Page, customer: string, letter: string, number: string) {
  const dialog = page.getByRole("dialog");
  const lot = `${letter}-${number}`;

  await freshPage(page);
  await goTo(page, "Lotes");
  await page.getByRole("banner").getByRole("button", { name: "Nuevo lote" }).click();
  await dialog.getByLabel("Proyecto").selectOption({ label: "Valle Verde" });
  await dialog.getByLabel("Letra del lote").fill(letter);
  await dialog.getByLabel("Número del lote").fill(number);
  await dialog.getByLabel("Área").fill("300");
  await dialog.getByLabel("Precio base").fill("150000");
  await dialog.getByRole("button", { name: "Crear lote" }).click();
  await expect(dialog).toHaveCount(0);

  await goTo(page, "Contratos");
  await page.getByRole("banner").getByRole("button", { name: "Nuevo contrato" }).click();
  await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill(customer);
  await dialog.getByRole("option", { name: new RegExp(customer) }).click();
  await dialog.getByRole("searchbox", { name: "Buscar lote" }).fill(lot);
  await dialog.getByRole("option", { name: new RegExp(lot) }).click();
  await dialog.getByRole("button", { name: "Continuar" }).click();
  await dialog.getByLabel("Prima acordada").fill("15000");
  await dialog.getByLabel("Plazo en meses").fill("12");
  await dialog.getByLabel("Día de pago").fill("15");
  await expect(dialog.getByLabel("Cuota mensual")).not.toHaveValue("");
  await dialog.getByRole("button", { name: "Crear contrato" }).click();
  await expect(dialog).toHaveCount(0);

  return lot;
}

/** Record a payment. The customer must have only one contract still owing. */
async function pay(page: Page, customer: string, amount: string) {
  const dialog = page.getByRole("dialog");

  await freshPage(page);
  await goTo(page, "Recibos");
  await page.getByRole("banner").getByRole("button", { name: "Nueva transacción" }).click();
  await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill(customer);
  await dialog.getByRole("option", { name: new RegExp(customer) }).click();
  await dialog.getByLabel("Monto *").fill(amount);
  await dialog.getByRole("button", { name: "Registrar y emitir recibo" }).click();
  await expect(dialog).toHaveCount(0);
}

/** Open the Constancia dialog of the customer's contract on `lot`. */
async function openConstancia(page: Page, lot: string) {
  await freshPage(page);
  await goTo(page, "Contratos");
  // Contratos opens on «Vigente», and a paid-off contract is not one.
  const clear = page.getByRole("button", { name: "Limpiar filtros" });
  if (await clear.isVisible()) {
    await clear.click();
  }
  await page.getByRole("searchbox", { name: "Buscar contrato" }).fill(lot);
  await page.locator("button.contract-open:visible, button.contract-card:visible").first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Constancia" }).click();

  return page.getByRole("dialog", { name: /Constancia del contrato/ });
}

/** Verify a printed code from Contratos, typed lower case with no hyphen, the way it is read down a phone. */
async function verify(page: Page, code: string) {
  await page.getByRole("button", { name: "Verificar una constancia" }).click();
  const dialog = page.getByRole("dialog", { name: "Verificar constancia" });
  await dialog.getByLabel("Código de verificación").fill(code.replace("-", "").toLowerCase());
  await dialog.getByRole("button", { name: "Verificar" }).click();

  return dialog.locator(".constancia-verdict");
}

test("a paid-off contract gets a constancia the office can verify", async ({ page }) => {
  const tag = uniqueTag();
  const customer = `Constancia ${tag}`;
  const lotNumber = String(parseInt(tag, 36) % 9000 + 1000);

  await logIn(page);
  await newCustomer(page, customer);
  const lot = await sellLot(page, customer, "X", lotNumber);
  // Paid off in two payments, so the history has more than one row.
  await pay(page, customer, "15000");
  await pay(page, customer, "135000");

  const constancia = await openConstancia(page, lot);
  await constancia.getByRole("button", { name: "Emitir constancia" }).click();

  // The letter; the annex sheets after it carry the same paper class.
  const paper = constancia.locator(".constancia-paper:not(.constancia-annex)");
  const annex = constancia.locator(".constancia-annex");
  await expect(paper).toContainText("Constancia de Cancelación Total");
  await expect(paper).toContainText(customer);
  await expect(paper).toContainText("CIENTO CINCUENTA MIL LEMPIRAS EXACTOS (L. 150,000.00)");
  await expect(paper).toContainText("SALDO CANCELADO");
  // The letter summarises by kind; the annex lists each payment, numbered.
  await expect(paper.locator(".constancia-history tbody tr")).toHaveCount(2);
  await expect(paper).toContainText("Prima");
  await expect(paper).toContainText("Total pagado · 2 pagos");
  await expect(paper).toContainText("Página 1 de 2");
  await expect(annex).toHaveCount(1);
  await expect(annex.locator("tbody tr")).toHaveCount(2);
  await expect(annex).toContainText("Anexo · Historial de pagos");
  await expect(annex).toContainText("Página 2 de 2");

  // Left out, the letter stands alone.
  await constancia.getByLabel("Incluir el historial completo de pagos (anexo)").uncheck();
  await expect(annex).toHaveCount(0);
  await expect(paper).not.toContainText("Página 1 de");
  await constancia.getByLabel("Incluir el historial completo de pagos (anexo)").check();
  await expect(constancia.getByRole("button", { name: "Imprimir" })).toBeVisible();

  await expect
    .poll(() => paper.locator(".receipt-logo img").evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);

  const code = (await paper.locator(".receipt-stamp strong").innerText()).trim();
  expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);

  await constancia.getByRole("button", { name: "Cerrar" }).last().click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await expect(await verify(page, code)).toContainText(`VÁLIDA — ${customer}`);
});

test("a customer's paid-off lots can share one constancia", async ({ page }) => {
  // Two lots sold and paid through the screens, one after the other.
  test.setTimeout(90_000);
  const tag = uniqueTag();
  const customer = `Conjunta ${tag}`;
  const lotNumber = String(parseInt(tag, 36) % 9000 + 1000);
  const dialog = page.getByRole("dialog");

  await logIn(page);
  await newCustomer(page, customer);
  // One lot at a time, so each payment has only one contract to go to.
  const first = await sellLot(page, customer, "V", lotNumber);
  await pay(page, customer, "150000");
  const second = await sellLot(page, customer, "W", lotNumber);
  await pay(page, customer, "15000");
  await pay(page, customer, "135000");

  const constancia = await openConstancia(page, second);
  const paper = constancia.locator(".constancia-paper:not(.constancia-annex)");

  // The other paid-off lot is offered; ticked, the two make one constancia.
  await constancia.getByLabel(new RegExp(`Lote ${first}`)).check();
  await constancia.getByRole("button", { name: "Emitir constancia de 2 lotes" }).click();

  await expect(paper).toContainText(`Lotes ${first} y ${second} del Valle Verde`);
  await expect(paper).toContainText("TRESCIENTOS MIL LEMPIRAS EXACTOS (L. 300,000.00)");
  await expect(paper).toContainText("dichos contratos no presentan saldo pendiente");
  await expect(paper.locator(".constancia-history tbody tr")).toHaveCount(2);
  await expect(paper).toContainText("Total pagado · 3 pagos · 2 lotes");
  const annex = constancia.locator(".constancia-annex");
  await expect(annex.locator("tbody tr")).toHaveCount(3);
  await expect(annex.locator("thead")).toContainText("Lote");

  const combinedCode = (await paper.locator(".receipt-stamp strong").innerText()).trim();

  // Unticked, the lot's own constancia is a separate one, issued on its own.
  await constancia.getByLabel(new RegExp(`Lote ${first}`)).uncheck();
  await expect(paper).toHaveCount(0);
  await constancia.getByRole("button", { name: "Emitir constancia", exact: true }).click();
  await expect(paper).toContainText(`Lote ${second} del Valle Verde`);
  const ownCode = (await paper.locator(".receipt-stamp strong").innerText()).trim();
  expect(ownCode).not.toBe(combinedCode);

  await constancia.getByRole("button", { name: "Cerrar" }).last().click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await expect(await verify(page, combinedCode)).toContainText(
    `VÁLIDA — ${customer}, Lotes ${first} y ${second} del Valle Verde`,
  );
});
