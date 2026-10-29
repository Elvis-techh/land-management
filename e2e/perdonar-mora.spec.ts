import type { Page } from "@playwright/test";

import { expect, goTo, logIn, screen, test, uniqueTag } from "./helpers";

/*
 * «Perdonar», end to end, with mora switched off in Configuración: cuota 1 is
 * late and unpaid, with L 500 of mora put on it today («Cargar mora», through
 * the API). Forgiving L 300 of it takes L 300 off the saldo; «Quitar» puts it
 * back.
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

async function lateWithMora(page: Page, today: string) {
  const tag = uniqueTag();
  const customer = `Perdonar ${tag}`;
  const lotCode = `P-${String((parseInt(tag, 36) % 9000) + 1000)}`;
  const firstDueOn = shiftDays(today, -40);
  const signedOn = shiftDays(today, -100);

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
  await post(`/api/contracts/${contract.id}/mora`, {
    installment: 1,
    incurredOn: today,
    amountCents: 50_000,
    reason: "Mora acordada por la cuota 1 atrasada.",
  });

  return { customer, code: contract.code as string };
}

test("«Perdonar» takes part of a cuota's unpaid mora off the saldo, and «Quitar» puts it back", async ({ page }, testInfo) => {
  const today = officeToday();
  const dialogs = page.getByRole("dialog");

  await logIn(page);
  const { customer, code } = await lateWithMora(page, today);

  await goTo(page, "Contratos");
  await screen(page).getByRole("searchbox", { name: "Buscar contrato" }).fill(customer);
  await page.locator(".contract-open:visible, .contract-card:visible").first().click();
  const panel = dialogs.first();
  await expect(panel).toContainText(code);
  await expect(panel.locator(".contract-progress-balance")).toContainText("L. 120,500");

  // The form starts on cuota 1 with all of its L 500; L 300 of it is forgiven.
  // By its heading: the summary above gains a «Mora perdonada» row too.
  const section = panel.locator(".cp-section", {
    has: page.getByRole("heading", { name: "Mora perdonada" }),
  });
  await section.getByRole("button", { name: "Perdonar" }).click();
  const form = page.getByRole("dialog", { name: /Perdonar mora/ });
  await expect(form.getByLabel("Cuota *")).toHaveValue("1");
  await expect(form.getByLabel("Monto *")).toHaveValue("500.00");
  await form.getByLabel("Monto *").fill("600");
  await expect(form).toContainText("No puede pasar de L. 500");
  await form.getByLabel("Monto *").fill("300");
  await form.getByLabel("Motivo *").fill("Se puso al día y se acordó perdonarle parte.");
  await form.screenshot({ path: testInfo.outputPath("perdonar-formulario.png") });
  await form.getByRole("button", { name: "Perdonar mora" }).click();
  await expect(form).toHaveCount(0);

  await expect(section).toContainText("Cuota 1");
  await expect(section).toContainText("L. 300");
  await expect(panel.locator(".contract-progress-balance")).toContainText("L. 120,200");
  await expect(panel.locator(".cp-row", { hasText: "Mora perdonada" })).toContainText("L. 300");
  await expect(panel.locator(".cp-row", { hasText: "Mora pendiente" })).toContainText("L. 200");
  await section.scrollIntoViewIfNeeded();
  await section.screenshot({ path: testInfo.outputPath("perdonar-contrato.png") });

  // «Quitar», with a reason: the L 300 is owed again.
  await section.getByRole("button", { name: /Quitar/ }).click();
  const remove = page.getByRole("dialog", { name: /Quitar perdón/ });
  await remove.getByLabel("Motivo *").fill("Se perdonó por error en esta prueba.");
  await remove.getByRole("button", { name: "Quitar perdón" }).click();
  await expect(remove).toHaveCount(0);
  await expect(panel.locator(".contract-progress-balance")).toContainText("L. 120,500");
  await expect(section).toContainText("Ninguna");
});
