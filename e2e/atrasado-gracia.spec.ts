import { expect, goTo, logIn, screen, test, uniqueTag } from "./helpers";

/*
 * The three labels around a due date. With the seed's 5 días de gracia
 * (settings.spec.ts puts them back to 5): a cuota that falls due today is
 * «Por vencer», one that fell due 5 days ago is «En gracia», and one that fell
 * due 6 days ago is «Atrasado» — the day the mora is charged, not on the last
 * day of grace itself. The sentence under the chip names the 5 days from
 * Configuración.
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

/** "05 mar 2026", as the Contratos list writes a date. */
function listDate(isoDate: string): string {
  const months = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const [year, month, day] = isoDate.split("-");
  return `${day} ${months[Number(month) - 1]} ${year}`;
}

test("a cuota is «Por vencer» on its due date, «En gracia» to the last day of grace, then «Atrasado»", async ({ page }, testInfo) => {
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

  const dueToday = `Hoyvence ${tag}`;
  const lastDay = `Gracia ${tag}`;
  const dayAfter = `Atraso ${tag}`;
  await cuotaDue(0, dueToday, `HY-${number}`);
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
  await expect(headline.locator(".contract-progress-head")).toContainText("En gracia");
  await expect(headline).toContainText("Venció una cuota y está dentro de los 5 días de gracia.");
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
  await panel.locator(".modal-close").click();
  await expect(dialogs).toHaveCount(0);

  // Due today: not past its date yet.
  const rows = page.locator(".contract-row:visible, .contract-card:visible");
  await search.fill(dueToday);
  await expect(rows).toHaveCount(1);
  await expect(rows.locator(".stamp")).toHaveText("Por vencer");

  // The list says the date passed. A phone card has no due date line.
  await search.fill(lastDay);
  await expect(rows).toHaveCount(1);
  await expect(rows.locator(".stamp")).toHaveText("En gracia");
  if (testInfo.project.name === "desktop") {
    await expect(rows).toContainText(`venció ${listDate(shiftDays(today, -5))}`);
  }
  await rows.screenshot({ path: testInfo.outputPath("en-gracia-en-la-lista.png") });

  // «En gracia» filters on its own: neither neighbour comes with it.
  await search.fill(tag);
  await expect(rows).toHaveCount(3);
  await screen(page).getByRole("button", { name: /Filtros/ }).click();
  await page.getByRole("checkbox", { name: "En gracia", exact: true }).check();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("En gracia");
  await page.screenshot({ path: testInfo.outputPath("filtro-en-gracia.png") });
  await page.getByRole("checkbox", { name: "En gracia", exact: true }).uncheck();
  await expect(rows).toHaveCount(3);
  await page.keyboard.press("Escape");

  // The Panel counts it in a box of its own, between its two neighbours.
  await goTo(page, "Panel general");
  const buckets = page.locator(".dash-bucket");
  await expect(buckets.locator(".stamp")).toHaveText([
    "Al día",
    "Por vencer",
    "En gracia",
    "Atrasado",
    "En riesgo",
  ]);
  await expect(buckets.nth(2)).toHaveAttribute(
    "title",
    "Venció una cuota y está dentro de los 5 días de gracia.",
  );
  expect(Number(await buckets.nth(2).locator(".dash-bucket-count").innerText())).toBeGreaterThan(0);
  await page.locator(".dash-buckets").screenshot({ path: testInfo.outputPath("panel-cobranza.png") });
});
