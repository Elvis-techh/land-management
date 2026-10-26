import type { Page } from "@playwright/test";

import { expect, goTo, logIn, screen, test, uniqueTag } from "./helpers";

/*
 * «Regla de mora» on one contract, end to end: a supervisor gives it its own
 * rule («Regla propia», L 300 fijos), which starts tomorrow, then puts it
 * back on the general one the same day, which simply undoes it.
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

async function signedOnCredit(page: Page, today: string) {
  const tag = uniqueTag();
  const customer = `Regla ${tag}`;
  const lotCode = `R-${String((parseInt(tag, 36) % 9000) + 1000)}`;
  const firstDueOn = shiftDays(today, 20);

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
    signedOn: shiftDays(today, -10),
    firstDueOn,
  });

  return { customer, code: contract.code as string };
}

test("a contract gets its own mora rule from tomorrow, and goes back to the general one", async ({ page }, testInfo) => {
  const today = officeToday();
  const dialogs = page.getByRole("dialog");

  await logIn(page);
  const { customer, code } = await signedOnCredit(page, today);

  await goTo(page, "Contratos");
  await screen(page).getByRole("searchbox", { name: "Buscar contrato" }).fill(customer);
  await page.locator(".contract-open:visible, .contract-card:visible").first().click();
  const panel = dialogs.first();
  await expect(panel).toContainText(code);

  const section = panel.locator(".cp-section", { hasText: "Regla de mora" });
  await expect(section).toContainText("La general");
  await expect(section).not.toContainText("Desde mañana");

  // «Regla propia»: L 300 fijos, once per late cuota.
  await section.getByRole("button", { name: "Cambiar" }).click();
  const form = page.getByRole("dialog", { name: /Regla de mora/ });
  await form.getByLabel("Regla *").selectOption("own");
  await form.getByLabel("Cómo se calcula").selectOption("fixed");
  await form.getByLabel("Monto fijo *").fill("300");
  await form.getByLabel("Máximo por cuota").fill("");
  await expect(form).toContainText(/Regla propia: L\. 300/);
  const save = form.getByRole("button", { name: "Guardar regla" });
  await expect(save).toBeDisabled();
  await form.getByLabel("Motivo *").fill("El contrato firmado dice L 300 fijos por cuota atrasada.");
  await form.screenshot({ path: testInfo.outputPath("regla-mora-formulario.png") });
  await save.click();
  await expect(form).toHaveCount(0);

  // Today still the general rule; the contract's own starts tomorrow.
  await expect(section).toContainText("La general");
  await expect(section.locator(".cp-mora-rule.is-upcoming")).toContainText(/Desde mañana: Regla propia: L\. 300/);
  await expect(section).toContainText("El contrato firmado dice L 300");
  await section.scrollIntoViewIfNeeded();
  await section.screenshot({ path: testInfo.outputPath("regla-mora-contrato.png") });

  // Back to the general rule the same day: tomorrow's change is undone.
  await section.getByRole("button", { name: "Cambiar" }).click();
  await form.getByLabel("Regla *").selectOption("general");
  await form.getByLabel("Motivo *").fill("Se puso por error en esta prueba.");
  await form.getByRole("button", { name: "Guardar regla" }).click();
  await expect(form).toHaveCount(0);
  await expect(section).not.toContainText("Desde mañana");
});
