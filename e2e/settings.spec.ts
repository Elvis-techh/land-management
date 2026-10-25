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

/*
 * The mora is set with the controls shaped like its answers: the switch opens
 * the rules, a tile picks how often, − and + move the grace days, and the
 * sentence under the switch follows every tap. Saved, it is still there after
 * a reload. The mora is switched off again at the end, as the seed has it.
 */
test("the supervisor sets the mora with the switch, the tiles and the steppers", async ({ page }, testInfo) => {
  await logIn(page);
  await goTo(page, "Configuración");

  const mora = page.getByRole("switch", { name: "Cobrar mora" });
  const summary = screen(page).locator(".cfg-summary");
  await expect(mora).toHaveAttribute("aria-checked", "false");
  await expect(summary).toHaveText("Apagada. Ningún contrato lleva mora.");
  await expect(page.getByText("¿Cuándo se cobra?")).toBeHidden();

  await mora.click();
  await expect(mora).toHaveAttribute("aria-checked", "true");
  await page.getByRole("spinbutton", { name: "Porcentaje" }).fill("2");
  await page.getByLabel("Desde", { exact: true }).fill("2030-01-01");
  await screen(page).locator(".cfg-tile", { hasText: "Cada mes" }).click();
  await expect(page.getByRole("radio", { name: /Cada mes/ })).toBeChecked();
  await page.getByLabel(/Sin mora si falta menos de/).fill("100");

  const grace = page.getByRole("spinbutton", { name: /Días de gracia/ });
  await page.getByRole("button", { name: "Un día más" }).click();
  await expect(grace).toHaveValue("6");
  await expect(summary).toContainText(
    "2 % de lo que falta de la cuota, cada mes que siga atrasada, después de 6 días de gracia, desde el 01 ene 2030. No se cobra si de la cuota falta menos de L. 100",
  );

  await page.screenshot({ path: testInfo.outputPath("configuracion-mora.png"), fullPage: true });

  // Back to the seed's five: the grace days already decide «Atrasado» today,
  // and the other tests count on it.
  await page.getByRole("button", { name: "Un día menos" }).click();
  await expect(grace).toHaveValue("5");

  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(screen(page)).toContainText("Cambios guardados.");

  await page.reload();
  await goTo(page, "Configuración");
  await expect(mora).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { name: /Cada mes/ })).toBeChecked();
  await expect(summary).toContainText("cada mes que siga atrasada, después de 5 días de gracia");
  await expect(page.getByLabel(/Sin mora si falta menos de/)).toHaveValue("100.00");

  await mora.click();
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(screen(page)).toContainText("Cambios guardados.");
  await expect(summary).toHaveText("Apagada. Ningún contrato lleva mora.");
});

test("the associate cannot change the mora", async ({ page }, testInfo) => {
  await logIn(page, accounts.staff);
  await goTo(page, "Configuración");

  await expect(screen(page)).toContainText("Solo el supervisor puede cambiarla o apagarla.");
  await expect(page.getByLabel("Cobrar mora")).toBeDisabled();
  await expect(page.getByLabel("Días de gracia")).not.toBeEditable();
  await expect(page.getByRole("button", { name: "Un día más" })).toBeDisabled();
  await expect(page.getByLabel("Teléfono")).not.toBeEditable();
  await expect(page.getByRole("button", { name: "Guardar cambios" })).toBeDisabled();

  await screen(page).screenshot({ path: testInfo.outputPath("configuracion-asociado.png") });
});
