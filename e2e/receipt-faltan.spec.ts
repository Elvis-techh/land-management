import { expect, goTo, logIn, test } from "./helpers";

/*
 * What a part payment still leaves owing is for the office, not for the
 * customer's copy (owner, 27 Nov 2026): the receipt confirms the money was
 * received, and «faltan L. X» is in the Nota del equipo beside it. The form
 * the payment is typed into keeps saying it, since that is where the person
 * recording it wants the figure.
 */

test("a part payment's receipt does not say what is missing, the Nota del equipo does", async ({
  page,
}, testInfo) => {
  const dialog = page.getByRole("dialog");

  await logIn(page);
  await goTo(page, "Recibos");
  await page.getByRole("banner").getByRole("button", { name: "Nueva transacción" }).click();
  await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill("José Rodríguez");
  await dialog.getByRole("option", { name: /José Rodríguez/ }).click();
  await dialog.getByLabel("Monto *").fill("1");

  // The form still says it.
  const after = dialog.locator(".after-payment");
  await expect(after).toContainText("Abono a cuota");
  await expect(after).toContainText("faltan L.");

  await dialog.getByRole("button", { name: "Registrar y emitir recibo" }).click();
  await expect(dialog).toHaveCount(0);

  // The receipt says which cuota the money went to, and nothing about what is missing.
  const paper = page.locator(".receipt-paper:visible").first();
  await expect(paper).toContainText("Abono a cuota");
  await expect(paper).not.toContainText("faltan");

  // The note box beside it says what is missing, for the lot, with no note typed.
  const note = page.locator(".receipt-memo");
  await expect(note).toContainText("Nota del equipo");
  await expect(note.locator(".receipt-memo-auto li")).toHaveCount(1);
  await expect(note.locator(".receipt-memo-auto li")).toContainText(/faltan L\.\s[\d,]+\.\d\d de la cuota \d+/);
  await expect(note.locator(".receipt-memo-text")).toHaveCount(0);

  // What a person types goes under it, and does not replace it.
  await note.getByRole("button", { name: "Agregar nota" }).click();
  await note.getByRole("textbox", { name: "Nota del recibo" }).fill("Pagará el resto el viernes.");
  await note.getByRole("button", { name: "Guardar" }).click();
  await expect(note.locator(".receipt-memo-text")).toHaveText("Pagará el resto el viernes.");
  await expect(note.locator(".receipt-memo-auto li")).toHaveCount(1);

  // Editing the note edits only what was typed: the lines are not in the box.
  await note.getByRole("button", { name: "Editar" }).click();
  await expect(note.getByRole("textbox", { name: "Nota del recibo" })).toHaveValue("Pagará el resto el viernes.");
  await note.getByRole("button", { name: "Cancelar" }).click();

  await note.screenshot({ path: testInfo.outputPath("nota-del-equipo.png") });
  await paper.screenshot({ path: testInfo.outputPath("recibo-sin-faltan.png") });
});

test("a receipt on several lots says what is missing on each lot that was part paid", async ({ page }) => {
  const dialog = page.getByRole("dialog");

  await logIn(page);
  await goTo(page, "Recibos");
  await page.getByRole("banner").getByRole("button", { name: "Nueva transacción" }).click();
  await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill("Ana Lucía Paz");
  await dialog.getByRole("option", { name: /Ana Lucía Paz/ }).click();
  await dialog.getByLabel("Monto *").fill("6");
  const amounts = dialog.locator(".split-table tbody tr:not(.split-mora-row) .col-receive input");
  await expect(amounts).toHaveCount(3);
  await amounts.nth(0).fill("1");
  await amounts.nth(1).fill("2");
  await amounts.nth(2).fill("3");
  await dialog.getByRole("button", { name: "Registrar y emitir recibo" }).click();
  await expect(dialog).toHaveCount(0);

  const paper = page.locator(".receipt-paper:visible").first();
  await expect(paper.locator(".receipt-items tbody tr")).toHaveCount(3);
  await expect(paper).not.toContainText("faltan");

  // One line per lot, each led by the lot's code as the paper prints it.
  const lines = page.locator(".receipt-memo .receipt-memo-auto li");
  await expect(lines).toHaveCount(3);

  const codes = await paper.locator(".receipt-item-lot").allInnerTexts();

  for (const [index, code] of codes.entries()) {
    const lot = code.split(" · ")[0]!.trim();
    await expect(lines.nth(index)).toContainText(`${lot}: faltan L.`);
  }
});
