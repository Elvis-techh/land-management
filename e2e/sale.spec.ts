import { expect, goTo, logIn, screen, test, uniqueTag } from "./helpers";

/*
 * The work Lindero exists for, start to finish: a new customer buys a new lot
 * on credit and pays the prima. Everything is created by the test with a name
 * of its own, so it never depends on (or disturbs) the demo data.
 */
test("a new customer buys a new lot and pays the prima", async ({ page }) => {
  const tag = uniqueTag();
  const customer = `Prueba ${tag}`;
  const lotNumber = String(parseInt(tag, 36) % 9000 + 1000);
  const lot = `Z-${lotNumber}`;
  const dialog = page.getByRole("dialog");

  await logIn(page);

  await test.step("register the customer", async () => {
    await goTo(page, "Clientes");
    await page.getByRole("banner").getByRole("button", { name: "Nuevo cliente" }).click();
    await dialog.getByLabel("Nombre completo").fill(customer);
    await dialog.getByLabel("Teléfono (opcional)").fill("9900-1122");
    await dialog.getByRole("button", { name: "Crear cliente" }).click();
    await expect(dialog).toHaveCount(0);

    await page.getByRole("searchbox", { name: "Buscar cliente" }).fill(customer);
    await expect(screen(page)).toContainText(customer);
  });

  await test.step("create the lot", async () => {
    await goTo(page, "Lotes");
    await page.getByRole("banner").getByRole("button", { name: "Nuevo lote" }).click();
    await dialog.getByLabel("Proyecto").selectOption({ label: "Valle Verde" });
    await dialog.getByLabel("Letra del lote").fill("Z");
    await dialog.getByLabel("Número del lote").fill(lotNumber);
    await dialog.getByLabel("Área").fill("300");
    await dialog.getByLabel("Precio base").fill("150000");
    await dialog.getByRole("button", { name: "Crear lote" }).click();
    await expect(dialog).toHaveCount(0);

    await expect(screen(page)).toContainText(lot);
  });

  await test.step("sign a credit contract", async () => {
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
    // The cuota fills itself in from the plazo.
    await expect(dialog.getByLabel("Cuota mensual")).not.toHaveValue("");
    await dialog.getByRole("button", { name: "Crear contrato" }).click();
    await expect(dialog).toHaveCount(0);
  });

  await test.step("the lot now belongs to the customer", async () => {
    await goTo(page, "Lotes");
    const row = page.getByRole("row", { name: new RegExp(lot) });
    await expect(row).toContainText(customer);
    await expect(row).toContainText(/Financiado/i);
  });

  await test.step("record the prima", async () => {
    await goTo(page, "Recibos");
    await page.getByRole("banner").getByRole("button", { name: "Nueva transacción" }).click();
    await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill(customer);
    await dialog.getByRole("option", { name: new RegExp(customer) }).click();
    await dialog.getByLabel("Monto *").fill("15000");
    await dialog.getByRole("button", { name: "Registrar y emitir recibo" }).click();
    await expect(dialog).toHaveCount(0);

    await page.getByRole("searchbox", { name: "Buscar transacciones" }).fill(customer);
    await expect(screen(page)).toContainText(customer);
    await expect(screen(page)).toContainText("15,000");
  });
});
