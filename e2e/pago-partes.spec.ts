import { expect, goTo, logIn, test, uniqueTag } from "./helpers";

/*
 * «Registrar un pago» says what the money does, in parts, and the parts follow
 * the payment's date (the owner's «A» and point 1, 10 Nov 2026).
 *
 * The owner's screenshot, made small: the prima is unpaid and cuota 1 is late,
 * with L 500 of mora put on it today. Paid today, the mora comes off first.
 * Dated back, before that mora existed, the whole amount goes to the prima and
 * the L 500 stays owed; the form used to show today's division for any date.
 *
 * The customer, lot and contract are the test's own, made through the API.
 */

const DAY_MS = 86_400_000;

/** Today in the office's calendar, as the server counts it. */
function officeToday(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Tegucigalpa",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function shiftDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

test("the payment's parts: the mora first today, none on a date before it was charged", async ({ page }, testInfo) => {
  const today = officeToday();
  const tag = uniqueTag();
  const customer = `Partes ${tag}`;
  const code = `Q-${String((parseInt(tag, 36) % 9000) + 1000)}`;
  const signedOn = shiftDays(today, -100);
  const firstDueOn = shiftDays(today, -40);
  const dialog = page.getByRole("dialog");

  await logIn(page);

  const post = async (url: string, data: unknown) => {
    const response = await page.request.post(url, { data });
    expect(response.status(), await response.text()).toBe(201);
    return response.json();
  };

  const { customer: created } = await post("/api/customers", {
    fullName: customer,
    customerSince: Number(today.slice(0, 4)),
  });
  const { lot } = await post("/api/lots", {
    code,
    projectName: "Valle Verde",
    areaM2: 300,
    basePriceCents: 13_500_000,
  });
  const { contract } = await post("/api/contracts", {
    customerId: created.id,
    lotId: lot.id,
    kind: "contract",
    saleType: "financed",
    salePriceCents: 13_500_000,
    downPaymentCents: 1_500_000,
    termMonths: 12,
    monthlyPaymentCents: 1_000_000,
    dueDay: Number(firstDueOn.slice(8, 10)),
    signedOn,
    firstDueOn,
  });
  await post(`/api/contracts/${contract.id}/mora`, {
    installment: 1,
    incurredOn: today,
    amountCents: 50_000,
    reason: "Mora acordada por la cuota 1 atrasada.",
  });

  await goTo(page, "Recibos");
  await page.getByRole("banner").getByRole("button", { name: "Nueva transacción" }).click();
  await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill(customer);
  await dialog.getByRole("option", { name: new RegExp(customer) }).click();

  // Saldo actual keeps the mora in it, and says how much.
  const balance = dialog.locator(".split-table tbody tr").first().locator("td").nth(1);
  await expect(balance).toContainText("L. 135,500");
  await expect(balance).toContainText("incluye mora L. 500");
  await expect(dialog.locator(".lot-mora")).toContainText("Mora por pagar L. 500");
  await expect(dialog.locator(".lot-mora")).toContainText("L. 500 por pagar.");

  const parts = dialog.getByRole("group", { name: `Este pago en ${code}` });
  const read = () =>
    parts
      .locator(".lot-parts-list > div")
      .evaluateAll((rows) =>
        rows.map((row) => `${row.querySelector("dt")!.textContent} ${row.querySelector("dd")!.textContent}`),
      );

  // The lot down to «Saldo restante» in one picture: a taller screen of the
  // same width while it is taken, so none of it is under the buttons.
  const shot = async (name: string) => {
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: size.width, height: 2000 });
    await page.mouse.move(0, 0);
    await dialog.locator(".split-preview").screenshot({ path: testInfo.outputPath(name), animations: "disabled" });
    await page.setViewportSize(size);
  };

  await dialog.getByLabel("Monto *").fill("15000");
  await expect.poll(read).toEqual(["Mora L. 500", "Prima L. 14,500", "Total L. 15,000"]);
  await expect(parts.locator(".lot-parts-head")).toHaveText("Este pago");
  await expect(parts.locator(".after-payment")).toContainText("faltan L. 500 de prima");
  await expect(dialog.locator(".receipt-running-total")).toContainText("L. 120,500");
  await shot("pago-partes-hoy.png");

  // Dated the day after signing: that mora did not exist yet. The whole amount
  // is the prima, and the L 500 is still owed afterwards.
  const back = shiftDays(signedOn, 1);
  await dialog.getByLabel("Fecha del pago *").fill(back);
  await expect.poll(read).toEqual(["Mora L. 0", "Prima L. 15,000", "Total L. 15,000"]);
  await expect(parts.locator(".lot-parts-head")).toContainText("Este pago, del");
  await expect(parts.locator(".after-payment")).toContainText("mora por pagar L. 500");
  await expect(parts.locator(".after-payment")).not.toContainText("faltan");
  // The lot as it stood that day (the owner's rule of 12 Nov 2026): no mora
  // yet and the prima not late, so nothing to say or change under it.
  await expect(dialog.locator(".lot-mora")).toHaveCount(0);

  // The saldo is that day's, the receipt's «Balance Anterior»: no mora yet.
  // Today's is under it (owner, 13 Nov 2026). The saldo restante follows, so
  // it is what the receipt will print as the new balance.
  await expect(dialog.locator(".split-table thead th").nth(1)).toHaveText(/^Saldo al \d+ \S+$/);
  await expect(balance.locator(".cell-money")).toHaveText("L. 135,000");
  await expect(balance).not.toContainText("incluye mora");
  await expect(balance).toContainText("hoy L. 135,500");
  await expect(dialog.locator(".receipt-running-total")).toContainText(/Saldo restante al \d+ \S+ L\. 120,000/);
  await expect(dialog.locator(".receipt-running-today")).toHaveText("hoy L. 120,500");
  await shot("pago-partes-fecha-pasada.png");

  // Saved with that date, the receipt and the lot say what the form said.
  await dialog.getByRole("button", { name: "Registrar y emitir recibo" }).click();
  await expect(page.getByRole("dialog", { name: "Registrar una transacción" })).toHaveCount(0);
  const paper = page.locator(".receipt-paper:visible").first();
  await expect(paper.locator(".receipt-highlight")).toContainText("L. 120,000.00");
  await expect(paper).toContainText("L. 135,000.00");
  const saved = (await (await page.request.get("/api/contracts")).json()).contracts.find(
    (row: { id: string }) => row.id === contract.id,
  );
  expect(saved.balance).toBe(12_050_000);
  expect(saved.mora.pending).toBe(50_000);

  // L 4,000 of cuota 1 paid: the line beside the saldo asks for what is still
  // missing of it, not for the whole cuota beside an «adelanto».
  await post("/api/receipts", {
    customerId: created.id,
    paidOn: shiftDays(back, 1),
    method: "cash",
    lines: [{ contractId: contract.id, amountCents: 400_000, type: "installment" }],
  });
  await page.reload();
  await goTo(page, "Recibos");
  await page.getByRole("banner").getByRole("button", { name: "Nueva transacción" }).click();
  await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill(customer);
  await dialog.getByRole("option", { name: new RegExp(customer) }).click();
  await expect(balance).toContainText("próxima: faltan L. 6,000 de L. 10,000");
  await expect(balance).not.toContainText("adelanto");
});
