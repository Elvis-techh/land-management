import { expect, goTo, logIn, test, uniqueTag } from "./helpers";

/*
 * The payment that pays a lot off issues a «RECIBO DE PAGO FINAL», with the
 * balance boxed in green as «Saldo Cancelado» rather than a red L. 0.00. The
 * customer, lot and contract are the test's own, so paying one off never
 * disturbs the demo data the other tests read.
 */
test("paying a lot off issues the final receipt", async ({ page }, testInfo) => {
  const tag = uniqueTag();
  const customer = `Final ${tag}`;
  const lotNumber = String(parseInt(tag, 36) % 9000 + 1000);
  const lot = `Y-${lotNumber}`;
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
  await dialog.getByLabel("Letra del lote").fill("Y");
  await dialog.getByLabel("Número del lote").fill(lotNumber);
  await dialog.getByLabel("Área").fill("300");
  // Seven figures, the widest amount a receipt line realistically carries, so
  // the check at the end covers the amount column at its tightest.
  await dialog.getByLabel("Precio base").fill("1250000");
  await dialog.getByRole("button", { name: "Crear lote" }).click();
  await expect(dialog).toHaveCount(0);

  await goTo(page, "Contratos");
  await page.getByRole("banner").getByRole("button", { name: "Nuevo contrato" }).click();
  await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill(customer);
  await dialog.getByRole("option", { name: new RegExp(customer) }).click();
  await dialog.getByRole("searchbox", { name: "Buscar lote" }).fill(lot);
  await dialog.getByRole("option", { name: new RegExp(lot) }).click();
  await dialog.getByRole("button", { name: "Continuar" }).click();
  await dialog.getByLabel("Prima acordada").fill("125000");
  await dialog.getByLabel("Plazo en meses").fill("12");
  await dialog.getByLabel("Día de pago").fill("15");
  await expect(dialog.getByLabel("Cuota mensual")).not.toHaveValue("");
  await dialog.getByRole("button", { name: "Crear contrato" }).click();
  await expect(dialog).toHaveCount(0);

  await goTo(page, "Recibos");
  await page.getByRole("banner").getByRole("button", { name: "Nueva transacción" }).click();
  await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill(customer);
  await dialog.getByRole("option", { name: new RegExp(customer) }).click();
  await dialog.getByLabel("Monto *").fill("1250000");
  await dialog.getByRole("button", { name: "Registrar y emitir recibo" }).click();
  await expect(dialog).toHaveCount(0);

  // The first copy: the second is the offscreen one the WhatsApp image is drawn from.
  const paper = page.locator(".receipt-paper:visible").first();
  await expect(paper).toContainText("RECIBO DE PAGO FINAL");
  await expect(paper).toContainText("Contrato pagado en su totalidad");
  await expect(paper).toContainText("Saldo Cancelado");
  await expect(paper).not.toContainText("Nuevo Balance Pendiente");
  await expect(paper).toContainText("¡Felicidades por su terreno!");

  // Every amount stays inside the document, however narrow the preview column:
  // the lot line's "L. 1,250,000.00" once ran past the right edge on a phone.
  const overflow = await paper.evaluate((el) => {
    const edge = el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight);
    return [...el.querySelectorAll(".receipt-right, .receipt-summary-row > span:last-child")]
      .map((cell) => {
        const range = document.createRange();
        range.selectNodeContents(cell);
        return { text: cell.textContent, past: range.getBoundingClientRect().right - edge };
      })
      .filter((cell) => cell.past > 0.5);
  });
  expect(overflow).toEqual([]);

  await paper.screenshot({ path: testInfo.outputPath("final-receipt.png") });
});
