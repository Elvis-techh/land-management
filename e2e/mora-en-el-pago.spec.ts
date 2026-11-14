import type { Page } from "@playwright/test";

import { accounts, expect, goTo, logIn, test, uniqueTag } from "./helpers";

/*
 * The mora changed in «Registrar un pago»: the owner's answers of 2026-11-06
 * (frontend/src/features/receipts/moraAtPayment.ts).
 *
 * One customer, two lots, cuota 1 of each 40 days late. Lot A owes L 500 of
 * mora (put on today through the API, as mora is switched off in this
 * database); lot B owes none. The supervisor charges A nothing and B L 200,
 * each with a reason, on one receipt: «Repartir» divides with the mora as
 * changed, and the receipt pays exactly that. The associate sees why A has
 * mora and cannot change it.
 *
 * The customer, lots and contracts are the test's own, made through the API.
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

async function twoLateLots(page: Page, today: string) {
  const tag = uniqueTag();
  const customer = `Mora en el pago ${tag}`;
  const base = (parseInt(tag, 36) % 8000) + 1000;
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

  const lots: Array<{ code: string; contractId: string }> = [];

  for (const offset of [0, 1]) {
    const code = `M-${base + offset}`;
    const { lot } = await post("/api/lots", {
      code,
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
    lots.push({ code, contractId: contract.id });
  }

  await post(`/api/contracts/${lots[0]!.contractId}/mora`, {
    installment: 1,
    incurredOn: today,
    amountCents: 50_000,
    reason: "Mora acordada por la cuota 1 atrasada.",
  });

  return { customer, a: lots[0]!, b: lots[1]! };
}

async function openPayment(page: Page, customer: string) {
  const dialog = page.getByRole("dialog");
  await goTo(page, "Recibos");
  await page.getByRole("banner").getByRole("button", { name: "Nueva transacción" }).click();
  await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill(customer);
  await dialog.getByRole("option", { name: new RegExp(customer) }).click();
  return dialog;
}

test("the supervisor charges one lot no mora and another L 200, each with a reason, on one receipt", async ({ page }, testInfo) => {
  const today = officeToday();
  await logIn(page);
  const { customer, a, b } = await twoLateLots(page, today);
  await page.reload();

  const dialog = await openPayment(page, customer);
  const moraA = dialog.locator(".lot-mora").filter({ hasText: "Mora por pagar L. 500" });

  // Why A has mora, and that B is late with none.
  // A line per cuota: when it fell due, what it owes, and how (2026-11-09, the owner's «B»).
  await expect(moraA).toContainText("Cuota 1, venció el");
  await expect(moraA).toContainText("Se cargó a mano el");
  await expect(moraA.locator(".lot-mora-why li")).toHaveCount(1);
  const late = dialog.locator(".lot-mora").filter({ hasText: "Atrasado: la cuota 1 venció el" });
  await expect(late).toBeVisible();
  // What the window shows first: why there is mora, and «Cobrar mora» on the late lot.
  await dialog.locator(".split-table").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("mora-en-el-pago-1.png") });

  // A: nothing. The field starts on what is owed; the reason appears once it changes.
  await dialog.getByRole("button", { name: `Cambiar la mora de ${a.code}` }).click();
  const fieldA = dialog.getByLabel(`Mora a cobrar a ${a.code}`);
  await expect(fieldA).toHaveValue("500.00");
  await expect(dialog.getByLabel("Por qué la cambias *")).toHaveCount(0);
  await fieldA.fill("0");
  await expect(dialog.getByLabel("Por qué la cambias *")).toHaveCount(1);

  // B: «Cobrar mora», L 200.
  await dialog.getByRole("button", { name: `Cobrar mora a ${b.code}` }).click();
  await dialog.getByLabel(`Mora a cobrar a ${b.code}`).fill("200");

  // «Repartir» divides with the mora as changed: A its cuota, B its cuota and L 200.
  await dialog.getByLabel("Monto *").fill("20200");
  await dialog.getByRole("button", { name: "Repartir el monto entre los lotes" }).click();
  await expect(dialog.locator(`#receipt-amount-${a.contractId}`)).toHaveValue("10,000.00");
  await expect(dialog.locator(`#receipt-amount-${b.contractId}`)).toHaveValue("10,200.00");
  // Each lot's money in parts (the owner's «A»): the mora as changed, then its cuota.
  const partsOf = (code: string) =>
    dialog
      .getByRole("group", { name: `Este pago en ${code}` })
      .locator(".lot-parts-list > div")
      .evaluateAll((rows) =>
        rows.map((row) => `${row.querySelector("dt")!.textContent} ${row.querySelector("dd")!.textContent}`),
      );
  await expect.poll(() => partsOf(a.code)).toEqual(["Mora L. 0", "Cuota L. 10,000", "Total L. 10,000"]);
  await expect.poll(() => partsOf(b.code)).toEqual(["Mora L. 200", "Cuota L. 10,000", "Total L. 10,200"]);
  const afterOf = (code: string) => dialog.getByRole("group", { name: `Este pago en ${code}` }).locator(".after-payment");
  await expect(afterOf(a.code)).not.toContainText("mora");
  await expect(afterOf(b.code)).not.toContainText("mora");
  // A: 120,500 − its L 500 − 10,000; B: 120,000 + L 200 − 10,200. L 110,000 each.
  await expect(dialog).toContainText("Saldo restante L. 220,000");

  // Not saved without the reasons: the caret goes to the first one missing,
  // in the order the lots are listed.
  await dialog.getByRole("button", { name: "Registrar y emitir recibo" }).click();
  const alert = dialog.getByRole("alert");
  await expect(alert).toContainText(/Escribe por qué cambias la mora de M-\d+/);
  const first = (await alert.textContent())!.includes(a.code) ? a : b;
  await expect(page.locator(`#receipt-mora-reason-${first.contractId}`)).toBeFocused();
  await page.locator(`#receipt-mora-reason-${a.contractId}`).fill("Contrato migrado de Airtable, sin mora pactada.");
  await page.locator(`#receipt-mora-reason-${b.contractId}`).fill("Acordado con el cliente por el atraso.");

  // Another date: no change is allowed, and the form says so.
  await dialog.getByLabel("Fecha del pago *").fill(shiftDays(today, -1));
  await expect(dialog.getByText("La mora solo se cambia en un pago con la fecha de hoy.").first()).toBeVisible();
  await dialog.getByLabel("Fecha del pago *").fill(today);

  // The change filled in, with the «después» line it gives.
  await dialog.locator(".lot-mora-edit").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("mora-en-el-pago-2.png"), animations: "disabled" });

  await dialog.getByRole("button", { name: "Registrar y emitir recibo" }).click();
  await expect(page.getByRole("dialog", { name: "Registrar una transacción" })).toHaveCount(0);

  // On file: A's L 500 forgiven, B's L 200 charged today, each with its reason.
  const moraOf = async (contractId: string) =>
    (await (await page.request.get(`/api/contracts/${contractId}/mora`)).json()) as {
      forgiven: Array<{ amountCents: number; reason: string }>;
      manual: Array<{ amountCents: number; incurredOn: string; reason: string; pendingCents: number }>;
    };
  const forgivenA = (await moraOf(a.contractId)).forgiven;
  expect(forgivenA.map((entry) => [entry.amountCents, entry.reason])).toEqual([
    [50_000, "Contrato migrado de Airtable, sin mora pactada."],
  ]);
  const chargedB = (await moraOf(b.contractId)).manual;
  expect(chargedB.map((entry) => [entry.amountCents, entry.incurredOn, entry.pendingCents])).toEqual([
    [20_000, today, 0],
  ]);
});

test("the associate sees why a lot has mora and cannot change it", async ({ page }) => {
  const today = officeToday();
  await logIn(page);
  const { customer, a } = await twoLateLots(page, today);
  await page.context().clearCookies();

  await logIn(page, accounts.staff);
  const dialog = await openPayment(page, customer);

  await expect(dialog.locator(".lot-mora").filter({ hasText: "Mora por pagar L. 500" })).toContainText(
    "Se cargó a mano el",
  );
  await expect(dialog.getByRole("button", { name: `Cambiar la mora de ${a.code}` })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Cobrar mora/ })).toHaveCount(0);
  await expect(dialog.getByText(/^Atrasado:/)).toHaveCount(0);
});
