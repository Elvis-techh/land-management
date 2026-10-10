import { accounts, expect, goTo, logIn, showMenu, test } from "./helpers";

test("a wrong password is refused and stays on the login screen", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Correo").fill(accounts.owner.email);
  await page.getByLabel("Contraseña").fill("not-the-password");
  await page.getByRole("button", { name: "Entrar" }).click();

  await expect(page.locator(".form-error")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Iniciar sesión" })).toBeVisible();
});

test("the supervisor logs in, stays logged in after a reload, and logs out", async ({ page }) => {
  await logIn(page);
  await expect(page.getByRole("banner")).toContainText("Panel general");

  await page.reload();
  await expect(page.getByRole("banner")).toContainText("Panel general");

  await showMenu(page);
  await page.getByRole("button", { name: "Cerrar sesión" }).click();
  await expect(page.getByRole("heading", { name: "Iniciar sesión" })).toBeVisible();
});

test("an associate does not see the supervisor's screens", async ({ page }) => {
  await logIn(page, accounts.staff);

  await goTo(page, "Lotes");
  const menu = page.getByRole("navigation");
  await expect(menu.getByRole("button", { name: "Permisos" })).toHaveCount(0);
  await expect(menu.getByRole("button", { name: "Usuarios" })).toHaveCount(0);
});
