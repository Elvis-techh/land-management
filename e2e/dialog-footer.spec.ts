import { expect, goTo, logIn, test } from "./helpers";

/*
 * The note at the bottom of «Corregir transacción» ("Escribe el motivo del
 * cambio…") used to share one line with «Cancelar» and «Guardar corrección»,
 * and on a phone it squeezed both buttons. There it now sits on its own line
 * above them; the buttons keep a line of their own, whole.
 */
test("the note in a dialog's footer leaves its buttons room", async ({ page }, testInfo) => {
  const dialog = page.getByRole("dialog");

  await logIn(page);
  await goTo(page, "Recibos");
  await page.locator("button.txn-edit:visible").first().click();
  await expect(dialog).toBeVisible();

  // Change the amount without a reason: the footer explains why it will not save.
  const amount = dialog.locator("#edit-amount");
  await amount.fill("1234");

  const note = dialog.locator(".modal-actions-hint");
  const cancel = dialog.locator(".modal-actions").getByRole("button", { name: /Cancelar|Cerrar/ });
  const save = dialog.locator(".modal-actions .modal-submit");
  await expect(note).toContainText("motivo del cambio");

  const noteBox = (await note.boundingBox())!;
  const cancelBox = (await cancel.boundingBox())!;
  const saveBox = (await save.boundingBox())!;

  // Neither button is cut: its text fits inside it.
  for (const button of [cancel, save]) {
    const fits = await button.evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
    expect(fits, "a footer button's text is cut").toBe(true);
  }

  if (testInfo.project.name === "phone") {
    expect(noteBox.y + noteBox.height, "the note is not above the buttons").toBeLessThanOrEqual(
      Math.min(cancelBox.y, saveBox.y) + 1,
    );
    expect(Math.abs(cancelBox.y - saveBox.y), "the buttons are not on one line").toBeLessThan(2);
  }
});
