import { expect, goTo, logIn, test } from "./helpers";

/*
 * The receipt image — what "Ver" shows and what goes out on WhatsApp — carries
 * the logo, even when the logo file arrives late.
 *
 * The image is drawn from an offscreen copy of the receipt as soon as one is
 * opened. If the logo has not finished downloading by then, the copy has an
 * empty, zero-height picture where the logo goes, and the image comes out
 * without it while the preview and the printout (drawn later) have it. On the
 * live site that is the usual case the first time a receipt is opened, so the
 * test makes it certain by holding the logo back for a moment.
 */
test("the receipt image includes the logo", async ({ page }) => {
  await page.route(/mr-investments.*\.png/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });

  await logIn(page);
  await goTo(page, "Recibos");

  // The demo payments were never put on paper, so make a receipt to look at.
  const dialog = page.getByRole("dialog");
  await page.getByRole("banner").getByRole("button", { name: "Nueva transacción" }).click();
  await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill("José Rodríguez");
  await dialog.getByRole("option", { name: /José Rodríguez/ }).first().click();
  await dialog.getByLabel("Monto *").fill("100");
  await dialog.getByRole("button", { name: "Registrar y emitir recibo" }).click();
  await expect(dialog).toHaveCount(0);

  await page.locator(".txn-main").filter({ hasNotText: "sin recibo" }).first().click();

  const ver = page.getByRole("button", { name: "Ver", exact: true });
  await expect(ver).toBeEnabled({ timeout: 15_000 });
  await ver.click();

  const shown = page.getByRole("dialog").locator('img[src^="blob:"]');
  await expect(shown).toBeVisible();

  /*
   * How much of the logo's own box is ink, in the image and in the logo file
   * itself drawn at the same size. Without the logo, that box holds at most
   * the top of the business name and is nearly all white.
   */
  const ink = await page.evaluate(async (imageUrl) => {
    const load = (src: string) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      });

    const stage = document.querySelector<HTMLElement>(".receipt-share-stage .receipt-paper")!;
    const logo = stage.querySelector<HTMLImageElement>(".receipt-logo img")!;
    const paperBox = stage.getBoundingClientRect();
    const logoBox = logo.getBoundingClientRect();
    const receipt = await load(imageUrl);
    const scale = receipt.naturalWidth / paperBox.width;

    const inkIn = (draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void) => {
      const w = Math.round(logoBox.width * scale);
      const h = Math.round(logoBox.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      draw(ctx, w, h);
      const { data } = ctx.getImageData(0, 0, w, h);
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! + data[i + 1]! + data[i + 2]! < 600) dark++;
      }
      return dark / (w * h);
    };

    const inImage = inkIn((ctx, w, h) =>
      ctx.drawImage(
        receipt,
        (logoBox.left - paperBox.left) * scale,
        (logoBox.top - paperBox.top) * scale,
        w,
        h,
        0,
        0,
        w,
        h,
      ),
    );
    const inLogo = inkIn((ctx, w, h) => ctx.drawImage(logo, 0, 0, w, h));

    return { inImage, inLogo };
  }, (await shown.getAttribute("src"))!);

  expect(ink.inLogo).toBeGreaterThan(0.05);
  expect(ink.inImage).toBeGreaterThan(ink.inLogo * 0.8);
});
