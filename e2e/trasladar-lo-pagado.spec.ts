import type { Page } from "@playwright/test";

import { expect, goTo, logIn, screen, test, uniqueTag } from "./helpers";

/*
 * «Trasladar lo pagado», end to end, on the case it was built for: a contract
 * with L 86,000 paid is replaced by an adenda whose new prima of L 54,000 the
 * customer has already paid. L 54,000 moves to the new contract as its prima
 * and L 32,000 is to be given back, then is given back.
 *
 * The customer, lot and contracts are the test's own, made through the API.
 */

/** Today in the office's calendar, as the server counts it. */
function officeToday(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Tegucigalpa",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function shiftDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** A contract with L 86,000 paid, replaced by an adenda. Returns both codes. */
async function replacedContract(page: Page) {
  const tag = uniqueTag();
  const customer = `Titular Adenda ${tag}`;
  const lotCode = `R-${String((parseInt(tag, 36) % 9000) + 1000)}`;
  const today = officeToday();
  const signed = shiftDays(today, -150);

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
    areaM2: 205,
    basePriceCents: 32_600_000,
  });
  const { contract } = await post("/api/contracts", {
    customerId: created.id,
    lotId: lot.id,
    kind: "contract",
    saleType: "financed",
    salePriceCents: 32_600_000,
    downPaymentCents: 3_000_000,
    termMonths: 60,
    monthlyPaymentCents: 600_000,
    dueDay: 20,
    signedOn: signed,
  });
  await post("/api/receipts", {
    customerId: created.id,
    paidOn: signed,
    method: "transfer",
    lines: [{ contractId: contract.id, amountCents: 8_600_000, type: "down_payment" }],
  });
  const amended = await post("/api/contracts/amendments", {
    effectiveOn: today,
    saleType: "financed",
    termMonths: 44,
    dueDay: 30,
    lines: [
      {
        contractId: contract.id,
        salePriceCents: 31_600_000,
        downPaymentCents: 5_400_000,
        monthlyPaymentCents: 600_000,
      },
    ],
    reason: "Nueva promesa de venta: L 316,000 con prima de L 54,000 ya recibida.",
  });

  return {
    customer,
    oldCode: contract.code as string,
    newCode: amended.contracts[0].code as string,
  };
}

test("money paid on a replaced contract moves to the new one, and the rest is given back", async ({ page }, testInfo) => {
  const dialogs = page.getByRole("dialog");

  await logIn(page);
  const { customer, oldCode, newCode } = await replacedContract(page);

  // The old contract: replaced, so «Reemplazado», which the default filter hides.
  await goTo(page, "Contratos");
  const clear = page.getByRole("button", { name: "Limpiar filtros" });
  if (await clear.isVisible()) {
    await clear.click();
  }
  await screen(page).getByRole("searchbox", { name: "Buscar contrato" }).fill(oldCode);
  await page.locator(".contract-open:visible, .contract-card:visible").filter({ hasText: oldCode }).first().click();
  const panel = dialogs.first();
  await expect(panel).toContainText(oldCode);
  const section = panel.locator(".cp-section", { hasText: "Lo pagado con este contrato" });
  await expect(section).toContainText("Queda como ingreso");
  await expect(section).toContainText("L. 86,000");

  // The decision: L 54,000 to the new contract as prima, L 32,000 back.
  await section.getByRole("button", { name: "Decidir lo pagado" }).click();
  const form = page.getByRole("dialog", { name: `Decidir lo pagado, contrato ${oldCode}` });
  await form.getByLabel(`Pasa a ${newCode}`).fill("54000");
  await expect(form.getByLabel("Cuenta como")).toHaveValue("down_payment");
  await form.getByLabel(`Se devuelve a ${customer}`).fill("32000");
  await expect(form.locator(".cp-row-total")).toContainText("L. 0");
  await form.getByLabel("Motivo *").fill("La nueva promesa dice que la prima ya está pagada; el resto se le devuelve.");
  await form.getByLabel("Motivo *").scrollIntoViewIfNeeded();
  await form.screenshot({ path: testInfo.outputPath("lo-pagado-formulario.png") });
  await form.getByRole("button", { name: "Guardar" }).click();
  await expect(form).toHaveCount(0);

  await expect(section).toContainText(`Pasó a ${newCode}`);
  await expect(section).toContainText(`Por devolver a ${customer}`);
  await expect(section).toContainText("L. 32,000");
  await expect(section).not.toContainText("Decidir lo pagado");
  await section.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: testInfo.outputPath("lo-pagado-contrato-anterior.png") });

  // The new contract counts the L 54,000 as its prima.
  await panel.getByRole("button", { name: newCode, exact: true }).click();
  await expect(panel.locator(".modal-header")).toContainText(newCode);
  await expect(panel.locator(".contract-progress-balance")).toContainText("L. 262,000");
  await expect(panel).toContainText("L. 54,000 pasaron a este contrato");

  // The day the L 32,000 goes back.
  await panel.getByRole("button", { name: oldCode, exact: true }).click();
  await expect(panel.locator(".modal-header")).toContainText(oldCode);
  await section.getByRole("button", { name: "Registrar devolución" }).click();
  const returning = page.getByRole("dialog", { name: `Registrar devolución, contrato ${oldCode}` });
  await returning.getByLabel("Cómo").selectOption("cash");
  await returning.getByRole("button", { name: "Registrar devolución" }).click();
  await expect(returning).toHaveCount(0);
  await expect(section).toContainText(`Devuelto a ${customer}`);
  await page.keyboard.press("Escape");

  // Recibos: the traslado says where it came from, and offers no correction.
  await goTo(page, "Recibos");
  await screen(page).getByRole("searchbox", { name: "Buscar transacciones" }).fill(newCode);
  const row = screen(page).locator(".txn-row, .txn-main").filter({ hasText: `Traslado de ${oldCode}` }).first();
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await row.screenshot({ path: testInfo.outputPath("lo-pagado-recibos.png") });
});
