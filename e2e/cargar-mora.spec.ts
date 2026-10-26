import type { Page } from "@playwright/test";

import { expect, goTo, logIn, screen, test, uniqueTag } from "./helpers";

/*
 * «Cargar mora», end to end, with mora switched off in Configuración: cuota 1
 * was paid ten days late with L 200 of mora on top, entered as one payment of
 * L 10,200. Putting that L 200 on cuota 1 by hand makes the old receipt show
 * it and raises the saldo by the same; «Quitar» takes it back.
 *
 * The customer, lot and contract are the test's own, made through the API.
 */

const DAY_MS = 86_400_000;

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
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

async function paidLateWithMora(page: Page, today: string) {
  const tag = uniqueTag();
  const customer = `Cargar ${tag}`;
  const lotCode = `C-${String((parseInt(tag, 36) % 9000) + 1000)}`;
  const firstDueOn = shiftDays(today, -40);
  const signedOn = shiftDays(today, -100);
  const paidOn = shiftDays(firstDueOn, 10);

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
  const { contract } = await post("/api/contracts", {
    customerId: created.id,
    lotId: lot.id,
    kind: "contract",
    saleType: "financed",
    salePriceCents: 13_500_000,
    downPaymentCents: 1_500_000,
    termMonths: 12,
    monthlyPaymentCents: 1_000_000,
    dueDay: Number(firstDueOn.slice(8, 10)),
    signedOn,
    firstDueOn,
  });
  await post("/api/receipts", {
    customerId: created.id,
    paidOn: signedOn,
    method: "cash",
    lines: [{ contractId: contract.id, amountCents: 1_500_000, type: "down_payment" }],
  });
  // Cuota 1 and L 200 of mora, as one payment.
  await post("/api/receipts", {
    customerId: created.id,
    paidOn,
    method: "cash",
    lines: [{ contractId: contract.id, amountCents: 1_020_000, type: "installment" }],
  });

  return { customer, code: contract.code as string, paidOn };
}

test("mora put on by hand moves an old payment's L 200 to mora, and «Quitar» takes it back", async ({ page }, testInfo) => {
  const today = officeToday();
  const dialogs = page.getByRole("dialog");

  await logIn(page);
  const { customer, code, paidOn } = await paidLateWithMora(page, today);

  await goTo(page, "Contratos");
  await screen(page).getByRole("searchbox", { name: "Buscar contrato" }).fill(customer);
  await page.locator(".contract-open:visible, .contract-card:visible").first().click();
  const panel = dialogs.first();
  await expect(panel).toContainText(code);
  await expect(panel.locator(".contract-progress-balance")).toContainText("L. 109,800");

  // The form: cuota 1, the day of that payment, L 200 and why.
  await panel.getByRole("button", { name: "Cargar mora" }).click();
  const form = page.getByRole("dialog", { name: /Cargar mora/ });
  await form.getByLabel("Cuota *").selectOption("1");
  await form.getByLabel("Fecha *").fill(paidOn);
  await form.getByLabel("Monto *").fill("200");
  await form.getByLabel("Motivo *").fill("Pagó L 200 de mora en efectivo junto con la cuota 1.");
  await form.screenshot({ path: testInfo.outputPath("cargar-mora-formulario.png") });
  await form.getByRole("button", { name: "Cargar mora" }).click();
  await expect(form).toHaveCount(0);

  // The L 200 was mora, so the saldo goes up by it, and it shows as paid.
  const section = panel.locator(".cp-section", { hasText: "Mora cargada a mano" });
  await expect(section).toContainText("Cuota 1");
  await expect(section).toContainText("L. 200");
  await expect(section).toContainText("Pagada");
  await expect(panel.locator(".contract-progress-balance")).toContainText("L. 110,000");
  await expect(panel.locator(".cp-row", { hasText: "Mora pagada" })).toContainText("L. 200");
  await section.scrollIntoViewIfNeeded();
  await section.screenshot({ path: testInfo.outputPath("cargar-mora-contrato.png") });

  // «Quitar», with a reason: the L 200 counts towards the price again.
  await section.getByRole("button", { name: /Quitar/ }).click();
  const remove = page.getByRole("dialog", { name: /Quitar mora/ });
  await remove.getByLabel("Motivo *").fill("Se cargó por error en esta prueba.");
  await remove.getByRole("button", { name: "Quitar mora" }).click();
  await expect(remove).toHaveCount(0);
  await expect(panel.locator(".contract-progress-balance")).toContainText("L. 109,800");
  await expect(section).toContainText("Ninguna");
});
