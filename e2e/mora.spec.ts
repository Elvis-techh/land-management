import { randomUUID } from "node:crypto";
import { join } from "node:path";

import Database from "better-sqlite3";
import type { Page } from "@playwright/test";

import { expect, goTo, logIn, screen, test, uniqueTag } from "./helpers";

/*
 * Mora, end to end: a contract two cuotas late shows its mora on the contract,
 * in «Registrar un pago» while the amount is typed, on the receipt and on the
 * Panel.
 *
 * The screen only lets mora start today or later, so a contract that is
 * ALREADY late with mora needs a version of the rules that began in the past.
 * That version is written straight into the test database (a throwaway copy,
 * see start-backend.mjs) and removed again at the end, so the demo contracts
 * the other tests read never carry mora outside this test. The customer, lot
 * and contract are the test's own.
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

/** 2 % of what is unpaid, once per cuota, five days of grace, mora first. */
function moraSince(databasePath: string, since: string): () => void {
  const rules = {
    enabled: true,
    startsOn: since,
    calculation: "percent",
    percent: 2,
    fixedCents: 0,
    graceDays: 5,
    capCents: null,
    frequency: "once",
    chargeDownPayment: false,
    paymentOrder: "mora",
  };
  const id = randomUUID();
  const db = new Database(databasePath);
  db.prepare("INSERT INTO mora_rules (id, effective_from, value) VALUES (?, ?, ?)").run(
    id,
    since,
    JSON.stringify(rules),
  );
  db.close();

  return () => {
    const again = new Database(databasePath);
    again.prepare("DELETE FROM mora_rules WHERE id = ?").run(id);
    again.close();
  };
}

/** A customer whose L 10,000 cuotas 1 and 2 are unpaid, through the API. */
async function lateCustomer(page: Page, today: string) {
  const tag = uniqueTag();
  const customer = `Mora ${tag}`;
  const lotCode = `M-${String((parseInt(tag, 36) % 9000) + 1000)}`;
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
  // The prima, paid when the contract was signed.
  await post("/api/receipts", {
    customerId: created.id,
    paidOn: signedOn,
    method: "cash",
    lines: [{ contractId: contract.id, amountCents: 1_500_000, type: "down_payment" }],
  });

  return { customer, code: contract.code as string };
}

test("mora shows on the contract, the payment, the receipt and the Panel", async ({ page }, testInfo) => {
  const today = officeToday();
  const dialog = page.getByRole("dialog");

  await logIn(page);
  const { customer, code } = await lateCustomer(page, today);
  const moraOff = moraSince(join(testInfo.config.rootDir, ".data", "lindero.db"), shiftDays(today, -60));

  try {
    // The contract: L 400 of mora, on its own line, and inside the saldo.
    await goTo(page, "Contratos");
    await screen(page).getByRole("searchbox", { name: "Buscar contrato" }).fill(customer);
    await page.locator(".contract-open:visible, .contract-card:visible").first().click();
    await expect(dialog).toContainText(code);
    await expect(dialog.locator(".cp-row", { hasText: "Mora pendiente" })).toContainText("L. 400");
    await expect(dialog.locator(".cp-row", { hasText: "Vencido sin pagar" })).toContainText("L. 20,000");
    await expect(dialog.locator(".contract-progress-balance")).toContainText("L. 120,400");
    await dialog.screenshot({ path: testInfo.outputPath("mora-contrato.png") });
    await dialog.getByRole("button", { name: "Cerrar" }).first().click();

    // While the amount is typed: the mora comes off first, then cuota 1.
    await goTo(page, "Recibos");
    await page.getByRole("banner").getByRole("button", { name: "Nueva transacción" }).click();
    await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill(customer);
    await dialog.getByRole("option", { name: new RegExp(customer) }).click();
    await dialog.getByLabel("Monto *").fill("10400");
    await expect(dialog.locator(".after-payment")).toContainText("mora L. 400 · Cuota 1 de 12 · completa");
    await dialog.screenshot({ path: testInfo.outputPath("mora-pago.png") });
    await dialog.getByRole("button", { name: "Registrar y emitir recibo" }).click();
    await expect(dialog).toHaveCount(0);

    // The receipt: the fee on its own line, and a summary that still adds up.
    const paper = page.locator(".receipt-paper:visible").first();
    await expect(paper).toContainText("Recargo por mora · cuotas 1 y 2 · L. 400.00");
    await expect(paper).toContainText("Cuota 1 de 12 · completa");
    await expect(paper.locator(".receipt-summary-row", { hasText: "Mora Cobrada" })).toContainText("L. 400.00");
    await expect(paper.locator(".receipt-highlight")).toContainText("L. 110,000.00");
    await paper.screenshot({ path: testInfo.outputPath("mora-recibo.png") });

    // Still one sheet when printed.
    const pdf = await page.pdf({ format: "A4" });
    expect(pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g)?.length).toBe(1);

    // The Panel: its own tile, with what was collected this month. Reloaded
    // first: issuing a receipt does not re-read the Panel (only a teammate's
    // write or coming back to the tab does), so it would still show the
    // figures from before this payment.
    await page.reload();
    await expect(page.getByRole("banner")).toBeVisible();
    await goTo(page, "Panel general");
    const tile = screen(page).locator(".dash-tile", { hasText: "Mora pendiente" });
    // At least this payment's L 400: the other screen size's run, earlier in
    // the same database, collected its own.
    await expect(tile).toContainText(/L\. [1-9][\d,]* cobrada en el mes/);
    await tile.screenshot({ path: testInfo.outputPath("mora-panel.png") });
  } finally {
    moraOff();
  }
});
