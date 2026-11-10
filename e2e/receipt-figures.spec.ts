import { writeFileSync } from "node:fs";

import type { Locator } from "@playwright/test";

import { expect, goTo, logIn, test } from "./helpers";

/*
 * The receipt's figures line up: in each column of amounts every «L.» stands
 * under the one above, and the digits end on one edge, the boxed balance
 * included (owner, 10 Nov 2026). Checked on the preview and on the copy the
 * WhatsApp image is drawn from, which is laid out at A4 width.
 *
 * Ana Lucía Paz's three lots take amounts of different sizes, so the lines
 * and the summary hold numbers of different lengths.
 */

/** The left edge of each «L.» and the right edge of each figure, as drawn. */
async function edges(scope: Locator, selector: string) {
  return scope.evaluate((root, selector) => {
    const textEdge = (element: Element, side: "left" | "right") => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect()[side];
    };

    return [...root.querySelectorAll(selector)].map((figure) => ({
      symbol: textEdge(figure.querySelector(".receipt-cur, .receipt-cur-cell")!, "left"),
      digits: textEdge(figure.querySelector(".receipt-num")!, "right"),
      text: figure.textContent,
    }));
  }, selector);
}

/** Between the «L.» and the widest figure: a space, not a gap. */
async function symbolGap(scope: Locator) {
  return scope.evaluate((root) => {
    const rect = (element: Element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect();
    };
    const rows = [...root.querySelectorAll(".receipt-items tbody tr")];
    const widest = Math.min(...rows.map((row) => rect(row.querySelector(".receipt-num")!).left));
    const symbol = rect(rows[0]!.querySelector(".receipt-cur-cell")!).right;
    const em = parseFloat(getComputedStyle(rows[0]!.querySelector(".receipt-num")!).fontSize);
    return (widest - symbol) / em;
  });
}

function expectLinedUp(figures: Array<{ symbol: number; digits: number; text: string | null }>, what: string) {
  expect(figures.length, what).toBeGreaterThan(1);
  const [first] = figures;

  for (const figure of figures) {
    expect(Math.abs(figure.symbol - first!.symbol), `${what}: «L.» of ${figure.text}`).toBeLessThan(0.5);
    expect(Math.abs(figure.digits - first!.digits), `${what}: digits of ${figure.text}`).toBeLessThan(0.5);
  }
}

test("the receipt's «L.» and digits line up in every column", async ({ page }, testInfo) => {
  const dialog = page.getByRole("dialog");

  await logIn(page);
  await goTo(page, "Recibos");
  await page.getByRole("banner").getByRole("button", { name: "Nueva transacción" }).click();
  await dialog.getByRole("searchbox", { name: "Buscar cliente" }).fill("Ana Lucía Paz");
  await dialog.getByRole("option", { name: /Ana Lucía Paz/ }).click();
  await dialog.getByLabel("Monto *").fill("13750.50");
  const amounts = dialog.locator(".split-table tbody tr:not(.split-mora-row) .col-receive input");
  await expect(amounts).toHaveCount(3);
  await amounts.nth(0).fill("12500");
  await amounts.nth(1).fill("250");
  await amounts.nth(2).fill("1000.50");
  await dialog.getByRole("button", { name: "Registrar y emitir recibo" }).click();
  await expect(dialog).toHaveCount(0);

  const preview = page.locator(".receipt-paper:visible").first();
  const stage = page.locator(".receipt-share-stage .receipt-paper");
  await expect(preview).toContainText("12,500.00");

  for (const [paper, where] of [
    [preview, "preview"],
    [stage, "WhatsApp copy"],
  ] as const) {
    expectLinedUp(await edges(paper, ".receipt-items tbody tr"), `${where}, lots`);
    expect(await symbolGap(paper), `${where}: «L.» next to the widest figure`).toBeLessThan(0.6);

    const together = await paper.evaluate(
      (element) => getComputedStyle(element.querySelector(".receipt-summary-col")!).display === "contents",
    );

    if (together) {
      // One list on a narrow preview: all five figures share one column.
      expectLinedUp(await edges(paper, ".receipt-summary-row, .receipt-highlight"), `${where}, summary`);
    } else {
      expectLinedUp(
        await edges(paper, ".receipt-summary-col:not(.is-wide) .receipt-summary-row"),
        `${where}, left column`,
      );
      expectLinedUp(
        await edges(paper, ".receipt-summary-col.is-wide .receipt-summary-row, .receipt-highlight"),
        `${where}, right column`,
      );
    }
  }

  await preview.screenshot({ path: testInfo.outputPath("recibo-cifras.png") });

  // The image itself, as it goes out on WhatsApp.
  const ver = page.getByRole("button", { name: "Ver", exact: true });
  await expect(ver).toBeEnabled({ timeout: 15_000 });
  await ver.click();
  const shown = page.getByRole("dialog").locator('img[src^="blob:"]');
  await expect(shown).toBeVisible();
  // Saved at its own size, the picture the customer receives.
  const dataUrl = await shown.evaluate(async (img: HTMLImageElement) => {
    const blob = await (await fetch(img.src)).blob();
    return new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });
  });
  writeFileSync(testInfo.outputPath("recibo-cifras-imagen.png"), Buffer.from(dataUrl.split(",")[1]!, "base64"));
});
