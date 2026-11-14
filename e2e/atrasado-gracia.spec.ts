import { expect, goTo, logIn, screen, test, uniqueTag } from "./helpers";

/*
 * «Atrasado» starts the day after the last day of grace, the day the mora is
 * charged, not on the last day itself. With the seed's 5 días de gracia
 * (settings.spec.ts puts them back to 5): a cuota that fell due 5 days ago is
 * still «Por vencer», and one that fell due 6 days ago is «Atrasado». The
 * sentence under the chip names the 5 days from Configuración.
 *
 * The customers, lots and contracts are the test's own, made through the API.
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

test("a cuota is «Por vencer» on its last day of grace and «Atrasado» the day after", async ({ page }, testInfo) => {
  const today = officeToday();
  const tag = uniqueTag();
  const number = (parseInt(tag, 36) % 9000) + 1000;
  const dialogs = page.getByRole("dialog");

  await logIn(page);

  const post = async (url: string, data: unknown) => {
    const response = await page.request.post(url, { data });
    expect(response.status(), await response.text()).toBe(201);
    return response.json();
  };

  /** A customer whose prima is paid and whose cuota 1 fell due `daysAgo` days ago, unpaid. */
  const cuotaDue = async (daysAgo: number, name: string, lotCode: string) => {
    const firstDueOn = shiftDays(today, -daysAgo);
    const signedOn = shiftDays(today, -100);
    const { customer } = await post("/api/customers", {
      fullName: name,
      customerSince: Number(today.slice(0, 4)),
    });
    const { lot } = await post("/api/lots", {
      code: lotCode,
      projectName: "Valle Verde",
      areaM2: 300,
      basePriceCents: 13_500_000,
    });
    const { contract } = await post("/api/contracts", {
      customerId: customer.id,
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
      customerId: customer.id,
      paidOn: signedOn,
      method: "cash",
      lines: [{ contractId: contract.id, amountCents: 1_500_000, type: "down_payment" }],
    });
    return contract.code as string;
  };

  const lastDay = `Gracia ${tag}`;
  const dayAfter = `Atraso ${tag}`;
  const lastDayCode = await cuotaDue(5, lastDay, `GR-${number}`);
  const dayAfterCode = await cuotaDue(6, dayAfter, `AT-${number}`);

  await goTo(page, "Contratos");
  const search = screen(page).getByRole("searchbox", { name: "Buscar contrato" });

  // Fell due 5 days ago: today is the last day of grace, no mora yet.
  await search.fill(lastDay);
  await page.locator(".contract-open:visible, .contract-card:visible").first().click();
  let panel = dialogs.first();
  await expect(panel).toContainText(lastDayCode);
  let headline = panel.locator(".cp-section").first();
  await expect(headline.locator(".contract-progress-head")).toContainText("Por vencer");
  await expect(headline).toContainText("Tiene una cuota próxima o dentro de los 5 días de gracia.");
  await headline.screenshot({ path: testInfo.outputPath("ultimo-dia-de-gracia.png") });
  await panel.locator(".modal-close").click();
  await expect(dialogs).toHaveCount(0);

  // Fell due 6 days ago: the grace is over, the same day the mora would be charged.
  await search.fill(dayAfter);
  await page.locator(".contract-open:visible, .contract-card:visible").first().click();
  panel = dialogs.first();
  await expect(panel).toContainText(dayAfterCode);
  headline = panel.locator(".cp-section").first();
  await expect(headline.locator(".contract-progress-head")).toContainText("Atrasado");
  await expect(headline).toContainText("Pasaron los 5 días de gracia y la cuota no entró.");
  await headline.screenshot({ path: testInfo.outputPath("dia-despues-de-la-gracia.png") });
});
