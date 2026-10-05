import type { MoneyView } from "../../lib/money";
import { cents, formatMoney } from "../../lib/money";
import { paymentTypeLabel } from "../receipts/paymentType";

/**
 * One line of a receipt as the Historial says it: "A-07 · CT-2026-004 · Cuota ·
 * L. 5,000".
 *
 * A void and a redistribution both keep the lines of a receipt as a list of
 * small objects, and `String()` turns every one of those into "[object Object]"
 * — so the one row that was meant to restate what a receipt covered printed
 * nothing about it. Only the parts a person would say are shown: the lot and
 * contract it was filed against, what kind of money it was, and how much.
 *
 * Anything that is not shaped like a line is shown as it is rather than hidden,
 * because the history is the last place a value should quietly go missing. An
 * older void stored the ids of the payments it reversed, and those still read
 * as the ids they are.
 */
export function formatAuditLine(line: unknown, money: MoneyView): string {
  if (line === null || typeof line !== "object") {
    return String(line);
  }

  const { lotCode, contractCode, type, amountCents } = line as Record<string, unknown>;

  const parts = [
    lotCode,
    contractCode,
    typeof type === "string" ? paymentTypeLabel(type) : null,
    typeof amountCents === "number" ? formatMoney(cents(amountCents), money) : null,
  ].filter((part): part is string => typeof part === "string");

  return parts.length > 0 ? parts.join(" · ") : JSON.stringify(line);
}

/** Every line of a receipt on one string, in the order they were stored. */
export function formatAuditList(items: readonly unknown[], money: MoneyView): string {
  return items.map((item) => formatAuditLine(item, money)).join("; ");
}
