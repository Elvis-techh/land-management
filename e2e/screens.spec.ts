import { expect, goTo, logIn, screen, test } from "./helpers";

/*
 * Every screen in the menu opens and shows its content. The automatic check in
 * helpers.ts also fails the test if any of them crashes or gets a server error.
 */
const screens: [tab: string, shows: RegExp][] = [
  ["Panel general", /Cobrado mes a mes/],
  ["Proyectos", /Activos \(\d+\)/],
  ["Lotes", /Mostrando \d+ de \d+ lotes/],
  ["Contratos", /Mostrando \d+ de \d+ contratos/],
  ["Clientes", /Mostrando \d+ de \d+ clientes/],
  ["Recibos", /Transacciones/],
  ["Historial", /Historial de cambios/],
  ["Permisos", /Qué puede hacer el asociado/],
  ["Usuarios", /Quién puede entrar/],
];

test("every screen opens", async ({ page }) => {
  await logIn(page);

  for (const [tab, shows] of screens) {
    await test.step(tab, async () => {
      await goTo(page, tab);
      await expect(screen(page)).toContainText(shows);
    });
  }
});
