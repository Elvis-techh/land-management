import { expect, goTo, logIn, test, uniqueTag } from "./helpers";

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

/*
 * «Nuevo Balance Pendiente» sits level with its amount, in the image as well
 * as on the page.
 *
 * The label once did not have the room: beside a six-figure amount it wrapped
 * onto two lines on the page, while in the image — drawn at twice the size,
 * where the text is a little narrower — it fitted on one. The box kept the
 * two-line height, so the label sat at the top of it and the amount in the
 * middle. A million-lempira lot is the widest case a receipt carries, so both
 * a six- and a seven-figure balance are checked. Each makes its own customer,
 * lot and contract so the balance is the one the test chose.
 */
for (const { digits, price, prima } of [
  { digits: "six", price: "250000", prima: "25000" },
  { digits: "seven", price: "1250000", prima: "125000" },
]) {
  test(`the boxed balance is level with its amount, ${digits} figures`, async ({ page }) => {
    const tag = uniqueTag();
    const customer = `Saldo ${tag}`;
    const lotNumber = String((parseInt(tag, 36) % 9000) + 1000);
    const lot = `Y-${lotNumber}`;
    const dialog = page.getByRole("dialog");

    await logIn(page);

    await goTo(page, "Clientes");
    await page.getByRole("banner").getByRole("button", { name: "Nuevo cliente" }).click();
    await dialog.getByLabel("Nombre completo").fill(customer);
    await dialog.getByRole("button", { name: "Crear cliente" }).click();
    await expect(dialog).toHaveCount(0);

    await goTo(page, "Lotes");
    await page.getByRole("banner").getByRole("button", { name: "Nuevo lote" }).click();
    await dialog.getByLabel("Proyecto").selectOption({ label: "Valle Verde" });
    await dialog.getByLabel("Letra del lote").fill("Y");
    await dialog.getByLabel("Número del lote").fill(lotNumber);
    await dialog.getByLabel("Área").fill("300");
    await dialog.getByLabel("Precio base").fill(price);
    await dialog.getByRole("button", { name: "Crear lote" }).click();
    await expect(dialog).toHaveCount(0);

    await goTo(page, "Contratos");
    await page.getByRole("banner").getByRole("button", { name: "Nuevo contrato" }).click();
    await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill(customer);
    await dialog.getByRole("option", { name: new RegExp(customer) }).click();
    await dialog.getByRole("searchbox", { name: "Buscar lote" }).fill(lot);
    await dialog.getByRole("option", { name: new RegExp(lot) }).click();
    await dialog.getByRole("button", { name: "Continuar" }).click();
    await dialog.getByLabel("Prima acordada").fill(prima);
    await dialog.getByLabel("Plazo en meses").fill("12");
    await dialog.getByLabel("Día de pago").fill("15");
    await expect(dialog.getByLabel("Cuota mensual")).not.toHaveValue("");
    await dialog.getByRole("button", { name: "Crear contrato" }).click();
    await expect(dialog).toHaveCount(0);

    await goTo(page, "Recibos");
    await page.getByRole("banner").getByRole("button", { name: "Nueva transacción" }).click();
    await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill(customer);
    await dialog.getByRole("option", { name: new RegExp(customer) }).click();
    await dialog.getByLabel("Monto *").fill("15000");
    await dialog.getByRole("button", { name: "Registrar y emitir recibo" }).click();
    await expect(dialog).toHaveCount(0);

    const ver = page.getByRole("button", { name: "Ver", exact: true });
    await expect(ver).toBeEnabled({ timeout: 15_000 });
    await ver.click();

    const shown = page.getByRole("dialog").locator('img[src^="blob:"]');
    await expect(shown).toBeVisible();

    const level = await page.evaluate(async (imageUrl) => {
      const receipt = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = imageUrl;
      });

      const paper = document.querySelector<HTMLElement>(".receipt-share-stage .receipt-paper")!;
      const box = paper.querySelector<HTMLElement>(".receipt-highlight")!;
      const label = box.querySelector<HTMLElement>(".receipt-highlight-label")!;
      const value = box.querySelector<HTMLElement>(".receipt-highlight-value")!;
      const paperBox = paper.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      const valueRect = value.getBoundingClientRect();
      const scale = receipt.naturalWidth / paperBox.width;

      const canvas = document.createElement("canvas");
      canvas.width = receipt.naturalWidth;
      canvas.height = receipt.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(receipt, 0, 0);

      /*
       * The rows that carry ink inside a stretch of the box, as the middle of
       * the first and last, in CSS pixels from the top of the box. The box's
       * own border is stepped over so it is never taken for text.
       */
      const inkMiddle = (left: number, right: number, isInk: (r: number, g: number, b: number) => boolean) => {
        const x = Math.round((left - paperBox.left) * scale);
        const w = Math.round((right - left) * scale);
        const y = Math.round((boxRect.top - paperBox.top + 3) * scale);
        const h = Math.round((boxRect.height - 6) * scale);
        const { data } = ctx.getImageData(x, y, w, h);
        let first = h;
        let last = -1;
        for (let row = 0; row < h; row++) {
          for (let col = 0; col < w; col++) {
            const i = (row * w + col) * 4;
            if (isInk(data[i]!, data[i + 1]!, data[i + 2]!)) {
              first = Math.min(first, row);
              last = Math.max(last, row);
              break;
            }
          }
        }
        return last < 0 ? NaN : (first + last) / 2 / scale + 3;
      };

      return {
        lines: Math.round(label.getBoundingClientRect().height / (parseFloat(getComputedStyle(label).fontSize) * 1.2)),
        boxMiddle: boxRect.height / 2,
        // The label's text is dark, the amount is red.
        label: inkMiddle(boxRect.left + 3, valueRect.left, (r, g, b) => r + g + b < 300),
        amount: inkMiddle(valueRect.left, boxRect.right - 3, (r, g, b) => r > 150 && g < 110 && b < 110),
      };
    }, (await shown.getAttribute("src"))!);

    // «Nuevo Balance Pendiente» is one line, not two, beside the widest amount.
    expect(level.lines).toBe(1);
    // Both are found, and both sit at the middle of the box: the bug put the
    // label about ten pixels above it.
    expect(level.label).not.toBeNaN();
    expect(level.amount).not.toBeNaN();
    expect(Math.abs(level.label - level.boxMiddle)).toBeLessThan(4);
    expect(Math.abs(level.amount - level.boxMiddle)).toBeLessThan(4);
  });
}
