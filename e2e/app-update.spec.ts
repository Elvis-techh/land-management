import { expect, goTo, logIn, test } from "./helpers";

/*
 * A page open since before a deploy keeps the old code, and an app installed
 * to a phone's home screen is hardly ever reloaded: «Enviar por WhatsApp» was
 * live and the owner's phone did not show it. The app now asks the server, on
 * coming back to the screen, whether its index.html names other scripts, and
 * offers the reload. Here the "deploy" is the test rewriting that answer.
 */
test("a newer version on the server is offered as a reload", async ({ page }) => {
  await logIn(page);

  // Above an open dialog, which is where a missing button gets noticed.
  await goTo(page, "Clientes");
  await page.getByRole("banner").getByRole("button", { name: "Nuevo cliente" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  const offer = page.locator(".update-banner");
  const comeBack = () => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

  // The same version: nothing to offer.
  await comeBack();
  await page.waitForTimeout(1_000);
  await expect(offer).toHaveCount(0);

  await page.route(
    (url) => url.pathname === "/",
    async (route) => {
      const response = await route.fetch();
      const html = (await response.text()).replace("/src/main.tsx", "/src/main.tsx?build=next");
      await route.fulfill({ response, body: html });
    },
  );

  await comeBack();
  await expect(offer).toContainText("Hay una versión nueva de Lindero.");

  // «Luego» puts it away until the next time the app is back on screen.
  await offer.getByRole("button", { name: "Luego" }).click();
  await expect(offer).toHaveCount(0);
  await comeBack();
  await expect(offer).toBeVisible();

  await page.unroute((url) => url.pathname === "/");
  await Promise.all([page.waitForEvent("load"), offer.getByRole("button", { name: "Actualizar" }).click()]);

  // Reloaded, still signed in, and up to date.
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await comeBack();
  await page.waitForTimeout(1_000);
  await expect(offer).toHaveCount(0);
});
