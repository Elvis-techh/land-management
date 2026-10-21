import { expect, goTo, logIn, test, uniqueTag } from "./helpers";

/*
 * A change made on one device shows on another that is already open, without
 * touching it. Reported as taking one to two minutes from a phone to the
 * office computer (#9); this measures it end to end.
 */
test("a change on the phone shows on the open computer within seconds", async ({ page, browser }) => {
  const computer = page;
  await logIn(computer);
  await goTo(computer, "Clientes");

  const phoneContext = await browser.newContext();
  const phone = await phoneContext.newPage();
  await logIn(phone);
  await goTo(phone, "Clientes");

  const name = `En vivo ${uniqueTag()}`;
  await phone.getByRole("banner").getByRole("button", { name: "Nuevo cliente" }).click();
  const dialog = phone.getByRole("dialog");
  await dialog.getByLabel("Nombre completo").fill(name);
  const saved = Date.now();
  await dialog.getByRole("button", { name: "Crear cliente" }).click();
  await expect(dialog).toHaveCount(0);

  await expect(computer.getByText(name)).toBeVisible({ timeout: 10_000 });
  const seconds = (Date.now() - saved) / 1000;
  console.log(`shown on the computer after ${seconds.toFixed(1)} s`);
  expect(seconds).toBeLessThan(5);

  await phoneContext.close();
});
