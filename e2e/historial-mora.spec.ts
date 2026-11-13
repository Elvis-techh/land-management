import { expect, goTo, logIn, screen, test, uniqueTag } from "./helpers";

/*
 * Historial says what a mora change did to the cuota: «Mora por pagar
 * L. 500 → L. 200», on the same entry, as its last row. Cuota 1 is late and
 * unpaid, with L 500 put on it by hand today and L 300 of it forgiven, both
 * through the API, with mora switched off in Configuración.
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

test("Historial shows the cuota's mora before and after a change", async ({ page }, testInfo) => {
  const today = officeToday();
  const tag = uniqueTag();
  const customer = `Historial ${tag}`;
  const firstDueOn = shiftDays(today, -40);
  const signedOn = shiftDays(today, -100);

  await logIn(page);

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
    code: `H-${String((parseInt(tag, 36) % 9000) + 1000)}`,
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
  await post(`/api/contracts/${contract.id}/mora/forgive`, {
    installment: 1,
    amountCents: 30_000,
    reason: "Se puso al día y se acordó perdonarle parte.",
  });

  await goTo(page, "Historial");
  await screen(page).getByRole("searchbox", { name: "Buscar en el historial" }).fill(contract.code);

  const forgiven = page.locator(".audit-item", { hasText: "Mora perdonada" }).first();
  const outcome = forgiven.locator(".audit-diff-row").last();
  await expect(outcome.locator(".audit-field")).toHaveText("Mora por pagar");
  await expect(outcome.locator(".audit-before")).toHaveText("L. 500");
  await expect(outcome.locator(".audit-after")).toHaveText("L. 200");

  const charged = page.locator(".audit-item", { hasText: "Mora cargada" }).first();
  const chargedOutcome = charged.locator(".audit-diff-row").last();
  await expect(chargedOutcome.locator(".audit-field")).toHaveText("Mora por pagar");
  await expect(chargedOutcome.locator(".audit-before")).toHaveText("L. 0");
  await expect(chargedOutcome.locator(".audit-after")).toHaveText("L. 500");

  await forgiven.screenshot({ path: testInfo.outputPath("historial-mora.png") });
});
