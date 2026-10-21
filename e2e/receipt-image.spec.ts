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

  // Saving opens the receipt it issued, so there is no row to tap first.

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

/*
 * The signature in the image is in Dancing Script, like the preview's, even
 * when Google Fonts cannot be reached.
 *
 * The image used to fetch the font from Google while it was drawn. On a
 * phone's data that failed now and then, and from then on every image was
 * signed in the phone's own cursive. The font now ships with the app, so the
 * test shuts Google out entirely. It measures how wide the signature's ink is
 * in the image and compares it with the name set in Dancing Script and in the
 * browser's own cursive: the two are far apart.
 */
test("the receipt image signs in Dancing Script without Google Fonts", async ({ page }) => {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());

  await logIn(page);
  await goTo(page, "Recibos");

  const dialog = page.getByRole("dialog");
  await page.getByRole("banner").getByRole("button", { name: "Nueva transacción" }).click();
  await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill("José Rodríguez");
  await dialog.getByRole("option", { name: /José Rodríguez/ }).first().click();
  await dialog.getByLabel("Monto *").fill("100");
  await dialog.getByRole("button", { name: "Registrar y emitir recibo" }).click();
  await expect(dialog).toHaveCount(0);

  const ver = page.getByRole("button", { name: "Ver", exact: true });
  await expect(ver).toBeEnabled({ timeout: 15_000 });
  await ver.click();

  const shown = page.getByRole("dialog").locator('img[src^="blob:"]');
  await expect(shown).toBeVisible();

  const widths = await page.evaluate(async (imageUrl) => {
    const receipt = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = imageUrl;
    });

    const paper = document.querySelector<HTMLElement>(".receipt-share-stage .receipt-paper")!;
    const name = paper.querySelector<HTMLElement>(".receipt-signature-name")!;
    const paperBox = paper.getBoundingClientRect();
    const nameBox = name.getBoundingClientRect();
    const scale = receipt.naturalWidth / paperBox.width;

    // The ink's left and right edges inside the name's box, in the image.
    const w = Math.round(nameBox.width * scale);
    const h = Math.round(nameBox.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(receipt, (nameBox.left - paperBox.left) * scale, (nameBox.top - paperBox.top) * scale, w, h, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    let left = w;
    let right = -1;
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        const i = (y * w + x) * 4;
        if (data[i]! + data[i + 1]! + data[i + 2]! < 450) {
          left = Math.min(left, x);
          right = Math.max(right, x);
          break;
        }
      }
    }

    const size = parseFloat(getComputedStyle(name).fontSize) * scale;
    const loaded = await document.fonts.load(`700 ${size}px "Dancing Script"`, name.textContent!);
    const setIn = (family: string) => {
      ctx.font = `700 ${size}px ${family}`;
      return ctx.measureText(name.textContent!).width;
    };

    return {
      fontLoaded: loaded.length > 0,
      ink: right - left,
      dancing: setIn('"Dancing Script"'),
      fallback: setIn("cursive"),
    };
  }, (await shown.getAttribute("src"))!);

  // The page has the font even with Google shut out: it came with the app.
  expect(widths.fontLoaded).toBe(true);
  // The two faces must be told apart for the next line to mean anything.
  expect(Math.abs(widths.dancing - widths.fallback)).toBeGreaterThan(widths.dancing * 0.1);
  expect(Math.abs(widths.ink - widths.dancing)).toBeLessThan(Math.abs(widths.ink - widths.fallback));
});
