import { expect, goTo, logIn, test, uniqueTag } from "./helpers";

/*
 * «Pagado por» from «Corregir transacción»: a receipt issued in the customer's
 * name can be put in the name of whoever handed over the money, from the same
 * form that corrects the amount, with the motive that form already asks for.
 * Alone, it is the same write the receipt panel's button makes; together with
 * an amount it goes in the same save.
 *
 * The customer, lot, contract and receipt are the test's own, made through the
 * API.
 */
test("«Pagado por» can be changed from «Corregir transacción»", async ({ page }, testInfo) => {
  const dialog = page.getByRole("dialog");
  const payer = "Carlos Mejía";
  const tag = uniqueTag();
  const customer = `Titular ${tag}`;
  const lotCode = `C-${String((parseInt(tag, 36) % 9000) + 1000)}`;
  const today = new Date().toISOString().slice(0, 10);

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
    dueDay: 5,
    signedOn: today,
    firstDueOn: today,
  });
  const { receipt } = await post("/api/receipts", {
    customerId: created.id,
    paidOn: today,
    method: "cash",
    lines: [{ contractId: contract.id, amountCents: 1_500_000, type: "down_payment" }],
  });

  const receiptNow = async () => {
    const response = await page.request.get(`/api/receipts/${receipt.id}`);
    expect(response.status()).toBe(200);
    return (await response.json()).receipt as { paidBy: string | null; lines: Array<{ amount: number }> };
  };

  const openCorrection = async () => {
    await goTo(page, "Recibos");
    await page.locator(`button.txn-edit[aria-label*="${customer}"]:visible`).first().click();
    await expect(dialog).toBeVisible();
  };

  const field = dialog.getByLabel("Pagado por (opcional)");
  const save = dialog.locator(".modal-actions .modal-submit");

  expect((await receiptNow()).paidBy).toBeNull();

  // Only the payer: nothing else moves, so it asks for the motive and nothing more.
  await openCorrection();
  await expect(field).toHaveValue("");
  await expect(dialog).toContainText("Vacío: el recibo sale a nombre del cliente.");
  await field.fill(payer);
  await expect(dialog).toContainText("cambia lo que dice el recibo");
  await expect(save).toBeDisabled();
  await field.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: testInfo.outputPath("pagado-por-campo.png") });
  await dialog.locator("#edit-reason").fill("El recibo debe salir a nombre de quien entregó el dinero.");
  await expect(save).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("pagado-por-motivo.png") });
  await save.click();
  await expect(dialog).toHaveCount(0);

  expect((await receiptNow()).paidBy).toBe(payer);

  // It comes back filled in, and goes back to the customer together with an amount.
  await openCorrection();
  await expect(field).toHaveValue(payer);
  await field.fill("");
  await dialog.locator("#edit-amount").fill("14000");
  await dialog.locator("#edit-reason").fill("Eran L. 14,000 y el recibo va a nombre del cliente.");
  await save.click();
  await expect(dialog).toHaveCount(0);

  const after = await receiptNow();
  expect(after.paidBy).toBeNull();
  expect(after.lines[0]!.amount).toBe(1_400_000);
});
