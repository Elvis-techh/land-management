import { expect, goTo, logIn, test, uniqueTag } from "./helpers";

/*
 * The whole life of a constancia de cancelación total: a lot is paid off, the
 * supervisor issues the constancia from the contract, and the office verifies
 * it from the code printed at its foot. The customer, lot and contract are the
 * test's own, so paying one off never disturbs the demo data.
 */
test("a paid-off contract gets a constancia the office can verify", async ({ page }) => {
  const tag = uniqueTag();
  const customer = `Constancia ${tag}`;
  const lotNumber = String(parseInt(tag, 36) % 9000 + 1000);
  const lot = `X-${lotNumber}`;
  const dialog = page.getByRole("dialog");

  await logIn(page);

  await goTo(page, "Clientes");
  await page.getByRole("banner").getByRole("button", { name: "Nuevo cliente" }).click();
  await dialog.getByLabel("Nombre completo").fill(customer);
  await dialog.getByRole("button", { name: "Crear cliente" }).click();
  await expect(dialog).toHaveCount(0);

  await goTo(page, "Lotes");
  await page.getByRole("banner").getByRole("button", { name: "Nuevo lote" }).click();
  await dialog.getByLabel("Proyecto").selectOption({ label: "Valle Verde" });
  await dialog.getByLabel("Letra del lote").fill("X");
  await dialog.getByLabel("Número del lote").fill(lotNumber);
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

  // Paid off in two payments, so the history has more than one row.
  for (const amount of ["15000", "135000"]) {
    // A fresh page each time: the receipt the last payment opened covers the
    // screen on a phone.
    await page.reload();
    await expect(page.getByRole("banner").first()).toBeVisible();
    await goTo(page, "Recibos");
    await page.getByRole("banner").getByRole("button", { name: "Nueva transacción" }).click();
    await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill(customer);
    await dialog.getByRole("option", { name: new RegExp(customer) }).click();
    await dialog.getByLabel("Monto *").fill(amount);
    await dialog.getByRole("button", { name: "Registrar y emitir recibo" }).click();
    await expect(dialog).toHaveCount(0);
  }

  await page.reload();
  await expect(page.getByRole("banner").first()).toBeVisible();
  await goTo(page, "Contratos");
  // Contratos opens on «Vigente», and a paid-off contract is not one.
  const clear = page.getByRole("button", { name: "Limpiar filtros" });
  if (await clear.isVisible()) {
    await clear.click();
  }
  await page.getByRole("searchbox", { name: "Buscar contrato" }).fill(customer);
  await page.locator("button.contract-open:visible, button.contract-card:visible").first().click();
  await dialog.getByRole("button", { name: "Constancia" }).click();

  const constancia = page.getByRole("dialog", { name: /Constancia del contrato/ });
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

  await page.getByRole("button", { name: "Verificar una constancia" }).click();
  const verify = page.getByRole("dialog", { name: "Verificar constancia" });
  // Typed the way a person reads it down a phone: lower case, no hyphen.
  await verify.getByLabel("Código de verificación").fill(code.replace("-", "").toLowerCase());
  await verify.getByRole("button", { name: "Verificar" }).click();
  await expect(verify.locator(".constancia-verdict")).toContainText(`VÁLIDA — ${customer}`);
});
