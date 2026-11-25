import type { Page } from "@playwright/test";

import { expect, goTo, logIn, screen, test, uniqueTag } from "./helpers";

/*
 * «Traspasar», end to end: a contract with a payment on it passes to another
 * customer. The contract then names the new holder and says who held it
 * before; the receipt already issued keeps the previous holder's name, and the
 * screen says why beside it.
 *
 * The customers, lot and contract are the test's own, made through the API.
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

/** Two customers, and a contract of the first with its prima paid. */
async function contractToHandOver(page: Page) {
  const tag = uniqueTag();
  const previous = `Titular Anterior ${tag}`;
  const next = `Titular Nuevo ${tag}`;
  const lotCode = `T-${String((parseInt(tag, 36) % 9000) + 1000)}`;
  const today = officeToday();

  const post = async (url: string, data: unknown) => {
    const response = await page.request.post(url, { data });
    expect(response.status(), await response.text()).toBe(201);
    return response.json();
  };

  const { customer: from } = await post("/api/customers", {
    fullName: previous,
    customerSince: Number(today.slice(0, 4)),
  });
  await post("/api/customers", { fullName: next, customerSince: Number(today.slice(0, 4)) });
  const { lot } = await post("/api/lots", {
    code: lotCode,
    projectName: "Valle Verde",
    areaM2: 300,
    basePriceCents: 33_000_000,
  });
  const { contract } = await post("/api/contracts", {
    customerId: from.id,
    lotId: lot.id,
    kind: "contract",
    saleType: "financed",
    salePriceCents: 33_000_000,
    downPaymentCents: 10_000_000,
    termMonths: 12,
    monthlyPaymentCents: 1_916_700,
    dueDay: 27,
    signedOn: today,
  });
  await post("/api/receipts", {
    customerId: from.id,
    paidOn: today,
    method: "transfer",
    lines: [{ contractId: contract.id, amountCents: 10_000_000, type: "down_payment" }],
  });

  return { previous, next, lotCode, code: contract.code as string };
}

test("a contract passes to another customer, and its old receipt keeps its name", async ({ page }, testInfo) => {
  const dialogs = page.getByRole("dialog");

  await logIn(page);
  const { previous, next, lotCode, code } = await contractToHandOver(page);

  await goTo(page, "Contratos");
  await screen(page).getByRole("searchbox", { name: "Buscar contrato" }).fill(previous);
  await page.locator(".contract-open:visible, .contract-card:visible").first().click();
  const panel = dialogs.first();
  await expect(panel).toContainText(code);

  // The form: who it passes to, the day, and why.
  await panel.getByRole("button", { name: "Traspasar" }).click();
  const form = page.getByRole("dialog", { name: `Traspasar ${code}` });
  await expect(form).toContainText(`Los recibos ya emitidos se quedan a nombre de ${previous}`);
  await form.getByRole("searchbox", { name: "Buscar cliente" }).fill(next);
  // Nobody is offered the contract they already hold.
  await expect(form.getByRole("option", { name: new RegExp(previous) })).toHaveCount(0);
  await form.getByRole("option", { name: new RegExp(next) }).click();
  await form.getByLabel("Motivo *").fill("La familia acordó el traspaso; nueva promesa de venta firmada.");
  await form.getByLabel("Motivo *").scrollIntoViewIfNeeded();
  await form.screenshot({ path: testInfo.outputPath("traspaso-formulario.png") });
  await form.getByRole("button", { name: `Traspasar a ${next}` }).click();
  await expect(dialogs).toHaveCount(0);

  // The contract is the new holder's, with the previous one on file.
  await screen(page).getByRole("searchbox", { name: "Buscar contrato" }).fill(next);
  await page.locator(".contract-open:visible, .contract-card:visible").first().click();
  await expect(panel).toContainText(code);
  await expect(panel.locator(".modal-description")).toContainText(next);
  const history = panel.locator(".cp-section", { hasText: "Traspasos" });
  await expect(history).toContainText(previous);
  await expect(history).toContainText(next);
  await expect(history).toContainText("nueva promesa de venta firmada");
  await history.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: testInfo.outputPath("traspaso-contrato.png") });
  await page.keyboard.press("Escape");
  await expect(dialogs).toHaveCount(0);

  // The prima's receipt: found by the previous holder's name, still in it,
  // and the screen says why.
  await goTo(page, "Recibos");
  await screen(page).getByRole("searchbox", { name: "Buscar transacciones" }).fill(previous);
  const row = screen(page).locator(".txn-row, .txn-main").filter({ hasText: lotCode }).first();
  await expect(row).toContainText(`Recibo: ${previous}`);
  await screen(page).locator(".txn-main", { hasText: lotCode }).first().click();
  const paper = page.locator(".receipt-paper:visible").first();
  await expect(paper.locator(".receipt-client-name")).toHaveText(previous);
  await expect(paper).not.toContainText(next);
  const note = page.locator(".receipt-holder-note:visible");
  await expect(note).toContainText(`Este recibo se emitió a nombre de ${previous}`);
  await expect(note).toContainText(`el lote ${lotCode} es de ${next}`);
  await page.screenshot({ path: testInfo.outputPath("traspaso-recibo.png") });
});
