import { expect, goTo, logIn, test } from "./helpers";

/** The smallest valid PNG: one transparent pixel. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/*
 * The lot picker beside an attached comprobante is sized by its own labels. It
 * used to take the whole row inside «Registrar un pago» (a form rule for every
 * select there outranked its own), squeezing out the filename and the size.
 */
test("the lot picker beside a comprobante takes only the room it needs", async ({ page }) => {
  const dialog = page.getByRole("dialog");

  await logIn(page);
  await goTo(page, "Recibos");
  await page.getByRole("banner").getByRole("button", { name: "Nueva transacción" }).click();
  // The demo customer with three lots, so the picker is shown.
  await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill("Ana Lucía Paz");
  await dialog.getByRole("option", { name: /Ana Lucía Paz/ }).click();
  // The picker offers the lots that receive money, so put money on them.
  await dialog.getByLabel("Monto *").fill("30000");
  await dialog.getByRole("button", { name: "Repartir el monto entre los lotes" }).click();

  await dialog
    .locator("input.proof-input")
    .setInputFiles({ name: "comprobante-transferencia.png", mimeType: "image/png", buffer: PIXEL });

  const row = dialog.locator(".proof-item");
  const picker = row.getByRole("combobox");
  await expect(picker).toHaveValue("");

  const sizes = await picker.evaluate((select: HTMLSelectElement) => {
    const style = getComputedStyle(select);
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return {
      picker: select.getBoundingClientRect().width,
      row: select.closest(".proof-item")!.getBoundingClientRect().width,
      // The default option's text, its padding and room for the arrow.
      label:
        context.measureText("Todo el recibo").width +
        parseFloat(style.paddingLeft) +
        parseFloat(style.paddingRight) +
        12,
    };
  });

  expect(sizes.picker, "the picker fills the row").toBeLessThan(sizes.row / 2);
  expect(sizes.picker, "«Todo el recibo» is cut").toBeGreaterThanOrEqual(sizes.label);

  await expect(row.getByRole("button", { name: /comprobante-transferencia/ }).last()).toBeVisible();
  const name = await row.locator(".proof-name").boundingBox();
  expect(name!.width, "the filename has no room").toBeGreaterThan(40);
});
