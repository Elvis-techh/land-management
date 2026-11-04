import type { Page } from "@playwright/test";

import { expect, goTo, logIn, screen, test, uniqueTag } from "./helpers";

/*
 * «Mora por mes» on the Panel: one contract with L 500 of mora put on by hand
 * today, L 200 of it forgiven. The month's line opens into its contracts, and a
 * contract opens from there. Other runs share this database, so the line's own
 * totals are only checked to be there; this contract's are checked exactly.
 */

const DAY_MS = 86_400_000;

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

async function contractWithMora(page: Page, today: string) {
  const tag = uniqueTag();
  const customer = `Mora Mes ${tag}`;
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
    code: `M-${String((parseInt(tag, 36) % 9000) + 1000)}`,
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
  await post(`/api/contracts/${contract.id}/mora`, {
    installment: 1,
    incurredOn: today,
    amountCents: 50_000,
    reason: "Mora acordada por la cuota 1 atrasada.",
  });
  await post(`/api/contracts/${contract.id}/mora/forgive`, {
    installment: 1,
    amountCents: 20_000,
    reason: "Se acordó perdonarle parte de la mora.",
  });

  return { customer, code: contract.code as string };
}

test("«Mora por mes» opens a month into its contracts, and a contract from there", async ({ page }, testInfo) => {
  await logIn(page);
  const { customer, code } = await contractWithMora(page, officeToday());

  await page.reload();
  await expect(page.getByRole("banner")).toBeVisible();
  await goTo(page, "Panel general");

  const band = screen(page).locator(".dash-card", { has: page.getByRole("heading", { name: "Mora por mes" }) });
  await expect(band.getByRole("columnheader", { name: "Perdonada" })).toBeVisible();
  await band.scrollIntoViewIfNeeded();

  await band.locator("tbody tr.is-clickable").first().click();
  const row = band.getByRole("button", { name: new RegExp(customer) });
  await expect(row).toContainText(code);
  await expect(row).toContainText("Cargada L. 500");
  await expect(row).toContainText("Perdonada L. 200");
  await expect(row).toContainText("Pendiente L. 300");
  // Nothing was paid, so that figure is left out rather than saying L. 0.
  await expect(row).not.toContainText("Cobrada");
  await band.screenshot({ path: testInfo.outputPath("mora-por-mes.png"), animations: "disabled" });

  // The page never slides sideways on a phone.
  const widths = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    screen: window.innerWidth,
  }));
  expect(widths.page).toBeLessThanOrEqual(widths.screen);

  await row.click();
  await expect(page.getByRole("dialog").first()).toContainText(code);
});
