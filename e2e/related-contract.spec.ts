import { type Page } from "@playwright/test";

import { expect, goTo, logIn, test, uniqueTag } from "./helpers";

/*
 * A second lot joined to an existing purchase starts from that purchase's
 * terms (#2): forma de pago, precio, prima, plazo, día de pago and the agreed
 * primera cuota are copied in, all still editable. The price is taken from the
 * first contract even though the two lots are listed at different prices, and
 * the hint says so — with the lot's own list price beside it.
 */
test("a contract joined to a purchase starts from that purchase's terms", async ({ page }) => {
  const tag = uniqueTag();
  const customer = `Compra ${tag}`;
  const lotNumber = String(parseInt(tag, 36) % 9000 + 1000);
  const firstLot = `Z-${lotNumber}`;
  const secondLot = `Y-${lotNumber}`;
  const dialog = page.getByRole("dialog");

  // Two months out, so it is after the signing date whatever today is.
  const due = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
  const firstDueOn = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-15`;

  await logIn(page);

  await test.step("register the customer and two lots", async () => {
    await goTo(page, "Clientes");
    await page.getByRole("banner").getByRole("button", { name: "Nuevo cliente" }).click();
    await dialog.getByLabel("Nombre completo").fill(customer);
    await dialog.getByRole("button", { name: "Crear cliente" }).click();
    await expect(dialog).toHaveCount(0);

    await goTo(page, "Lotes");
    await createLot(page, "Z", lotNumber, "150000");
    await createLot(page, "Y", lotNumber, "160000");
  });

  await test.step("sign the first lot on negotiated terms", async () => {
    await openNewContract(page, customer, firstLot);
    await dialog.getByRole("button", { name: "Continuar" }).click();

    await dialog.getByLabel("Precio de venta").fill("140000");
    await dialog.getByLabel("Prima acordada").fill("20000");
    await dialog.getByLabel("Plazo en meses").fill("48");
    await dialog.getByLabel("Día de pago").fill("15");
    await dialog.getByLabel("Primera cuota").fill(firstDueOn);
    await dialog.getByRole("button", { name: "Crear contrato" }).click();
    await expect(dialog).toHaveCount(0);
  });

  await test.step("the second lot, joined to that purchase, starts from its terms", async () => {
    await openNewContract(page, customer, secondLot);
    const purchase = dialog.getByLabel("¿Es parte de una compra que ya existe?");
    const firstPurchase = purchase.locator("option", { hasText: `Lote ${firstLot}` });
    await purchase.selectOption((await firstPurchase.getAttribute("value"))!);
    await dialog.getByRole("button", { name: "Continuar" }).click();

    await expect(dialog.getByLabel("Forma de pago")).toHaveValue("financed");
    await expect(dialog.getByLabel("Precio de venta")).toHaveValue(/^140,?000\.00$/);
    await expect(dialog).toContainText(/Tomado de CT-\S+\. El lote está en lista a L\.? ?160,000/);
    await expect(dialog.getByLabel("Prima acordada")).toHaveValue(/^20,?000\.00$/);
    await expect(dialog.getByLabel("Plazo en meses")).toHaveValue("48");
    await expect(dialog.getByLabel("Día de pago")).toHaveValue("15");
    await expect(dialog.getByLabel("Primera cuota")).toHaveValue(firstDueOn);
    // The cuota follows from the copied numbers: 120,000 over 48 months.
    await expect(dialog.getByLabel("Cuota mensual")).toHaveValue(/^2,?500\.00$/);

    // Still editable: the second lot was negotiated at its own price.
    await dialog.getByLabel("Precio de venta").fill("145000");
    await expect(dialog).not.toContainText("Tomado de");
    await dialog.getByRole("button", { name: "Crear contrato" }).click();
    await expect(dialog).toHaveCount(0);
  });
});

async function createLot(page: Page, letter: string, number: string, price: string) {
  const dialog = page.getByRole("dialog");

  await page.getByRole("banner").getByRole("button", { name: "Nuevo lote" }).click();
  await dialog.getByLabel("Proyecto").selectOption({ label: "Valle Verde" });
  await dialog.getByLabel("Letra del lote").fill(letter);
  await dialog.getByLabel("Número del lote").fill(number);
  await dialog.getByLabel("Área").fill("300");
  await dialog.getByLabel("Precio base").fill(price);
  await dialog.getByRole("button", { name: "Crear lote" }).click();
  await expect(dialog).toHaveCount(0);
}

async function openNewContract(page: Page, customer: string, lot: string) {
  const dialog = page.getByRole("dialog");

  await goTo(page, "Contratos");
  await page.getByRole("banner").getByRole("button", { name: "Nuevo contrato" }).click();
  await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill(customer);
  await dialog.getByRole("option", { name: new RegExp(customer) }).click();
  await dialog.getByRole("searchbox", { name: "Buscar lote" }).fill(lot);
  await dialog.getByRole("option", { name: new RegExp(lot) }).click();
}
