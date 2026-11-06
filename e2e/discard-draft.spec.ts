import { type Page } from "@playwright/test";

import { expect, goTo, logIn, test, uniqueTag } from "./helpers";

/*
 * QI-6: «Cancelar» is a decision. With something typed, it asks «¿Descartar lo
 * escrito?»; «Seguir escribiendo» keeps the form as it was, and «Descartar»
 * closes it AND forgets the draft, so the next open does not offer back
 * «Quedó algo a medio escribir» for work that was just thrown away.
 *
 * The draft is written after the typing pauses for 800 ms (lib/formDrafts.ts),
 * so each case waits past that before cancelling. Without the wait the old
 * behaviour would pass by accident: there would be no draft to offer.
 */
const DRAFT_SAVED = 1_200;

test("Cancelar on a typed Nuevo lote asks, and Descartar forgets the draft", async ({ page }) => {
  const dialog = page.getByRole("dialog", { name: "Nuevo lote" });
  const confirm = page.getByRole("dialog", { name: /Descartar el lote/ });

  await logIn(page);
  await goTo(page, "Lotes");

  await test.step("an empty form still closes at once", async () => {
    await openNewLot(page);
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(confirm).toHaveCount(0);
  });

  await test.step("«Seguir escribiendo» keeps what was typed", async () => {
    await openNewLot(page);
    await dialog.getByLabel("Área").fill("321");
    await page.waitForTimeout(DRAFT_SAVED);

    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await expect(confirm).toContainText("¿Descartar lo escrito?");
    await confirm.getByRole("button", { name: "Seguir escribiendo" }).click();

    await expect(confirm).toHaveCount(0);
    await expect(dialog.getByLabel("Área")).toHaveValue("321");
  });

  await test.step("«Descartar» closes, and the next form starts blank", async () => {
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await confirm.getByRole("button", { name: "Descartar" }).click();
    await expect(dialog).toHaveCount(0);

    await openNewLot(page);
    await expect(dialog).not.toContainText("Quedó algo a medio escribir");
    await expect(dialog.getByLabel("Área")).toHaveValue("");
  });
});

test("the X on a Nuevo contrato with a customer chosen asks, and forgets", async ({ page }) => {
  const customer = `Descarte ${uniqueTag()}`;
  const dialog = page.getByRole("dialog", { name: "Nuevo contrato" });
  const confirm = page.getByRole("dialog", { name: /Descartar el contrato/ });

  await logIn(page);

  await goTo(page, "Clientes");
  await page.getByRole("banner").getByRole("button", { name: "Nuevo cliente" }).click();
  await page.getByRole("dialog").getByLabel("Nombre completo").fill(customer);
  await page.getByRole("dialog").getByRole("button", { name: "Crear cliente" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await goTo(page, "Contratos");
  await page.getByRole("banner").getByRole("button", { name: "Nuevo contrato" }).click();
  await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill(customer);
  await dialog.getByRole("option", { name: new RegExp(customer) }).click();
  await page.waitForTimeout(DRAFT_SAVED);

  await dialog.getByRole("button", { name: "Cerrar" }).click();
  await confirm.getByRole("button", { name: "Descartar" }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByRole("banner").getByRole("button", { name: "Nuevo contrato" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toContainText("Quedó algo a medio escribir");
});

async function openNewLot(page: Page) {
  await page.getByRole("banner").getByRole("button", { name: "Nuevo lote" }).click();
  await expect(page.getByRole("dialog", { name: "Nuevo lote" })).toBeVisible();
}
