import type { Page } from "@playwright/test";

import { expect, logIn, goTo, screen, test, uniqueTag } from "./helpers";

/*
 * QI-7: «Ya hay un recibo de este cliente por el mismo monto y la misma fecha»
 * used to sit in the form under «Nota», so on a phone it was below the screen
 * while the customer and the amount were being typed up top. It is now pinned
 * to the bottom of the dialog, above «Registrar y emitir recibo», and shows
 * wherever the form is scrolled.
 */

/** A customer with a financed contract and nothing paid yet, made through the API. */
async function customerWithContract(page: Page) {
  const tag = uniqueTag();
  const customer = `Doble ${tag}`;
  const lotCode = `D-${String((parseInt(tag, 36) % 9000) + 1000)}`;
  const today = new Date().toISOString().slice(0, 10);

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
  await post("/api/contracts", {
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

  return customer;
}

test("the duplicate-payment warning stays in sight, above the button", async ({ page }) => {
  const dialog = page.getByRole("dialog");

  await logIn(page);
  const customer = await customerWithContract(page);

  const openPayment = async () => {
    const back = screen(page).locator(".receipt-sheet-back");
    if (await back.isVisible()) {
      await back.click();
    }
    await page.getByRole("button", { name: "Nueva transacción" }).click();
    await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill(customer);
    await dialog.getByRole("option", { name: new RegExp(customer) }).click();
    await dialog.getByLabel("Monto *").fill("15000");
  };

  await goTo(page, "Recibos");

  await test.step("a first payment of L. 15,000 today", async () => {
    await openPayment();
    await dialog.getByRole("button", { name: "Registrar y emitir recibo" }).click();
    await expect(dialog).toHaveCount(0);
  });

  await test.step("the same amount again: the warning is on screen with the form at its top", async () => {
    await openPayment();
    const warning = dialog
      .locator(".form-blocked, .form-warning")
      .filter({ hasText: "Ya hay un recibo de este cliente" });
    await expect(warning).toBeVisible();

    // Back to the top of the form, where the customer and amount are typed.
    await dialog.evaluate((panel) => panel.scrollTo(0, 0));
    expect(await dialog.evaluate((panel) => panel.scrollTop)).toBe(0);
    await expect(warning).toBeInViewport({ ratio: 1 });

    // And it sits above the button it warns about, which is on screen too.
    const register = dialog.getByRole("button", { name: "Registrar y emitir recibo" });
    await expect(register).toBeInViewport();
    const warningBox = (await warning.boundingBox())!;
    const registerBox = (await register.boundingBox())!;
    expect(warningBox.y + warningBox.height).toBeLessThanOrEqual(registerBox.y);
  });
});
