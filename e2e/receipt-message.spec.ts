import { expect, goTo, logIn, test } from "./helpers";

/*
 * «Enviar» opens the customer's chat with a message written for what the
 * payment did — the cuota it covered and what is next — rather than the same
 * thank-you for every receipt. WhatsApp itself is not opened: `window.open` is
 * recorded instead, and the clipboard accepts the image without a permission
 * prompt, so the test reads the message from the chat link.
 */
test("the WhatsApp message says what the payment covered", async ({ page }) => {
  await page.addInitScript(() => {
    const opened: string[] = [];
    (window as unknown as { opened: string[] }).opened = opened;
    window.open = ((url: string) => {
      opened.push(url);
      return null;
    }) as typeof window.open;
    Object.defineProperty(navigator, "clipboard", {
      value: { write: async () => {} },
      configurable: true,
    });
  });

  const dialog = page.getByRole("dialog");

  await logIn(page);
  await goTo(page, "Recibos");
  await page.getByRole("banner").getByRole("button", { name: "Nueva transacción" }).click();
  await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill("José Rodríguez");
  await dialog.getByRole("option", { name: /José Rodríguez/ }).click();
  await dialog.getByLabel("Monto *").fill("1000");
  await dialog.getByRole("button", { name: "Registrar y emitir recibo" }).click();
  await expect(dialog).toHaveCount(0);

  // The first copy: the second is the offscreen one the WhatsApp image is drawn from.
  const send = page.locator("button.receipt-send:visible").first();
  await expect(send).toBeEnabled({ timeout: 15_000 });
  await send.click();

  const opened = () => page.evaluate(() => (window as unknown as { opened: string[] }).opened);
  await expect.poll(async () => (await opened()).length).toBeGreaterThan(0);

  const message = new URL((await opened())[0]!).searchParams.get("text") ?? "";
  // An abono on one of José's cuotas, or the end of one: which depends on what
  // the other tests paid before this one, on the same demo customer.
  expect(message).toMatch(/^Gracias por su (abono|pago) de \*L\. 1,000\.00\* (a la cuota|\(cuota) \d+/);
  expect(message).toMatch(/Cualquier duda me deja saber\.$/);
});
