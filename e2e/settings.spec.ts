import { accounts, expect, goTo, logIn, screen, test, uniqueTag } from "./helpers";

/*
 * The Configuración screen: the supervisor changes a business detail, it is
 * kept after a reload and filed in Historial; the associate can read the mora
 * rules and cannot change them.
 */
test("the supervisor saves the business details", async ({ page }, testInfo) => {
  await logIn(page);
  await goTo(page, "Configuración");

  const phone = `+504 9${uniqueTag()}`;
  await page.getByLabel("Teléfono").fill(phone);
  await expect(screen(page).locator(".settings-footer-preview")).toContainText(`Tel: ${phone}`);

  await screen(page).screenshot({ path: testInfo.outputPath("configuracion.png") });

  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(screen(page)).toContainText("Cambios guardados.");

  await page.reload();
  await goTo(page, "Configuración");
  await expect(page.getByLabel("Teléfono")).toHaveValue(phone);

  await goTo(page, "Historial");
  await expect(screen(page).locator(".audit-item").first()).toContainText("Datos del negocio");
  await expect(screen(page).locator(".audit-item").first()).toContainText(phone);
});

test("the associate cannot change the mora", async ({ page }, testInfo) => {
  await logIn(page, accounts.staff);
  await goTo(page, "Configuración");

  await expect(screen(page)).toContainText("Solo el supervisor puede cambiarla o apagarla.");
  await expect(page.getByLabel("Cobrar mora")).toBeDisabled();
  await expect(page.getByLabel("Días de gracia")).not.toBeEditable();
  await expect(page.getByLabel("Teléfono")).not.toBeEditable();
  await expect(page.getByRole("button", { name: "Guardar cambios" })).toBeDisabled();

  await screen(page).screenshot({ path: testInfo.outputPath("configuracion-asociado.png") });
});
