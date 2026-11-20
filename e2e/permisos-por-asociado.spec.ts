import { accounts, expect, goTo, logIn, screen, test } from "./helpers";

/*
 * QI-5 step 3: the supervisor gives ONE associate a permission the general
 * list doesn't, the associate gets it on their next page load, and putting
 * them back on the general list takes it away again. The test ends on the
 * general list, so the second run (and every other test) starts from it.
 */
test("one associate gets permissions of their own", async ({ page, browser }, testInfo) => {
  const associate = accounts.staff.name;

  await logIn(page);
  await goTo(page, "Permisos");

  await page.getByRole("button", { name: associate, exact: true }).click();
  await expect(screen(page)).toContainText(`Qué puede hacer ${associate}`);

  // Following the general list, the switches are shown but can't be moved.
  const archive = page.getByRole("checkbox", { name: /Archivar lotes/ });
  await expect(archive).toBeDisabled();
  await expect(archive).not.toBeChecked();

  await page.getByRole("radio", { name: /Permisos propios/ }).check();
  await expect(screen(page)).toContainText("Por ahora igual que los generales");
  await page.screenshot({ path: testInfo.outputPath("permisos-pantalla.png") });
  await archive.check();

  const archiveRow = page.locator(".permission-row", { has: archive });
  await expect(archiveRow).toContainText("Distinto de los generales: los demás asociados no pueden.");
  await expect(screen(page)).toContainText("1 permiso distinto de los generales");

  // For the pull request: the person view, on a phone and a desktop.
  await page.locator(".permissions-intro").screenshot({ path: testInfo.outputPath("permisos-propios.png") });
  await archiveRow.screenshot({ path: testInfo.outputPath("permiso-distinto.png") });

  await page.getByRole("button", { name: `Guardar permisos de ${associate}` }).click();
  await expect(screen(page)).toContainText("Cambios guardados.");
  await expect(page.getByRole("button", { name: `${associate} · propios` })).toBeVisible();

  // The associate, in a browser of their own, can now archive a lot.
  const other = await browser.newContext({ ...testInfo.project.use, baseURL: testInfo.project.use.baseURL });
  const associatePage = await other.newPage();
  await logIn(associatePage, accounts.staff);
  await goTo(associatePage, "Lotes");
  await expect(associatePage.getByRole("button", { name: /^Archivar lote / }).first()).toBeAttached();

  // Usuarios says who has a list of their own.
  await goTo(page, "Usuarios");
  const associateRow = page.getByRole("row", { name: new RegExp(accounts.staff.email) });
  await expect(associateRow).toContainText("Permisos propios");

  // The Historial says what changed, in the screen's words.
  await goTo(page, "Historial");
  const latest = page.locator(".audit-item").first();
  await expect(latest).toContainText(associate);
  await expect(latest).toContainText("Ahora puede");
  await expect(latest).toContainText("Archivar lotes");
  await latest.screenshot({ path: testInfo.outputPath("historial-permisos.png"), animations: "disabled" });

  // Back to the general list: the permission goes away on the next load.
  await goTo(page, "Permisos");
  await page.getByRole("button", { name: `${associate} · propios` }).click();
  await page.getByRole("radio", { name: /Los permisos generales/ }).check();
  await page.getByRole("button", { name: `Guardar permisos de ${associate}` }).click();
  await expect(screen(page)).toContainText("Cambios guardados.");
  await expect(page.getByRole("button", { name: associate, exact: true })).toBeVisible();

  await associatePage.reload();
  await goTo(associatePage, "Lotes");
  await expect(screen(associatePage)).toContainText(/Mostrando \d+ de \d+ lotes/);
  await expect(associatePage.getByRole("button", { name: /^Archivar lote / })).toHaveCount(0);

  await other.close();
});
