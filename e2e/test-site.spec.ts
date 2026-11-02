import { accounts, expect, goTo, logIn, test } from "./helpers";

/*
 * The test site is a whole second Lindero on the internet, with fake data. The
 * danger is somebody treating it as the real one, so it has to say what it is
 * on every screen, before anyone has logged in, and without changing the layout
 * being tested. The real site must show none of this.
 *
 * Playwright runs a second copy of the frontend built the way the Deploy test
 * workflow builds it: VITE_SITE=test (see playwright.config.ts).
 */
const testSite = `http://localhost:${process.env.E2E_TEST_SITE_PORT ?? 5175}`;
/** A branch as long as a cloud session's, so the phone test sees it cut short. */
const branch = "ccr-9a01639b-hz7sp2";

test.describe("the test site", () => {
  test("says so before anyone logs in, and is hidden from search engines", async ({ page }) => {
    await page.goto(testSite);
    await expect(page.getByRole("note")).toHaveText(/SITIO DE PRUEBA/);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(page).toHaveTitle(/PRUEBA/);
  });

  test("says which branch and commit it is running, so a phone can tell a change has arrived", async ({ page }) => {
    // Set for this copy in playwright.config.ts, as the Deploy test workflow does.
    await page.goto(testSite);
    const strip = page.getByRole("note");
    await expect(strip).toContainText("SITIO DE PRUEBA · No registre pagos reales");
    await expect(strip.locator(".test-site-branch")).toHaveText(branch);
    await expect(strip.locator(".test-site-commit")).toHaveText("abc1234");

    // Still one line, even on a phone, so it covers no more of the page than
    // before: the branch gives way, and the commit stays whole.
    const box = await strip.boundingBox();
    expect(box!.height).toBeLessThan(24);
    const commit = await strip.locator(".test-site-commit").boundingBox();
    expect(commit!.x + commit!.width).toBeLessThanOrEqual(box!.x + box!.width);
    await page.screenshot({ path: test.info().outputPath("test-site-strip.png") });
  });

  test("keeps saying so on every screen, and never gets in the way of a tap", async ({ page }) => {
    await page.goto(testSite);
    await page.getByLabel("Correo").fill(accounts.owner.email);
    await page.getByLabel("Contraseña").fill(accounts.owner.password);
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByRole("banner")).toBeVisible();

    await goTo(page, "Recibos");
    const strip = page.getByRole("note");
    await expect(strip).toBeVisible();

    // Whatever sits under the strip still receives the tap.
    const box = await strip.boundingBox();
    const underneath = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.className ?? "",
      { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
    );
    expect(underneath).not.toContain("test-site-banner");
  });

  test("opens the messaging apps with no recipient, because a demo number may be a stranger's", async ({ page }) => {
    await page.goto(testSite);
    const urls = await page.evaluate(async () => {
      const whatsapp = await import("/src/features/receipts/whatsapp.ts" as string);
      return { chat: whatsapp.chatUrl("+50499447781", "hola") as string };
    });
    expect(urls.chat).toBe("https://wa.me/?text=hola");
  });
});

test.describe("the real site", () => {
  test("shows none of it", async ({ page }) => {
    await logIn(page);
    await expect(page.getByText("SITIO DE PRUEBA")).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
    await expect(page).toHaveTitle("Lindero");

    const urls = await page.evaluate(async () => {
      const whatsapp = await import("/src/features/receipts/whatsapp.ts" as string);
      return { chat: whatsapp.chatUrl("+50499447781", "hola") as string };
    });
    expect(urls.chat).toBe("https://wa.me/50499447781?text=hola");
  });
});
