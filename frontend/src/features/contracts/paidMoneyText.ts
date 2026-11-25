import type { MoneyView } from "../../lib/money";
import { cents, formatMoney } from "../../lib/money";
import type { ContractCarryover, ContractPaidMoney } from "../../types";

/**
 * What became of the money paid on a contract that is no longer running, in
 * one sentence for its panel: «L. 54,000 pasaron a CT-2026-090-A1 y
 * L. 32,000 están por devolver.»
 *
 * Before anything was decided (`null`) the old default stands: all of it
 * stays as income. Every lempira is in one of four places — moved, owed back,
 * given back, or still income — and the sentence names each one that is not
 * empty, so the figures in it always add up to what was paid.
 */
export function paidMoneySentence(
  paidMoney: ContractPaidMoney | null,
  paidToDateCents: number,
  money: MoneyView,
): string {
  const amount = (value: number) => formatMoney(cents(value), money);

  if (paidMoney === null) {
    return paidToDateCents > 0 ? "Lo pagado quedó como ingreso." : "No se pagó nada con este contrato.";
  }

  const parts: string[] = [];
  const byCode = new Map<string, number>();

  for (const entry of paidMoney.carryovers) {
    byCode.set(entry.code, (byCode.get(entry.code) ?? 0) + entry.amountCents);
  }

  for (const [code, total] of byCode) {
    parts.push(`${amount(total)} pasaron a ${code}`);
  }

  const owed = paidMoney.refunds.filter((refund) => refund.returnedOn === null);
  const given = paidMoney.refunds.filter((refund) => refund.returnedOn !== null);
  const sum = (list: { amountCents: number }[]) => list.reduce((total, entry) => total + entry.amountCents, 0);

  if (owed.length > 0) {
    parts.push(`${amount(sum(owed))} ${owed.length === 1 && parts.length === 0 ? "está" : "están"} por devolver`);
  }
  if (given.length > 0) {
    parts.push(`${amount(sum(given))} se devolvieron`);
  }
  if (paidMoney.keptCents > 0) {
    parts.push(`${amount(paidMoney.keptCents)} quedan como ingreso`);
  }

  if (parts.length === 0) {
    return "Lo pagado quedó como ingreso.";
  }

  const sentence =
    parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]!}`;

  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/**
 * On the contract that replaced another: what of the old contract's money
 * counts here. «L. 86,000 · L. 54,000 pasaron a este contrato», or the old
 * wording while nothing was moved.
 */
export function carriedInNote(
  predecessorPaidCents: number,
  carriedIn: readonly ContractCarryover[],
  money: MoneyView,
): string {
  const paid = formatMoney(cents(predecessorPaidCents), money);
  const carried = carriedIn.reduce((total, entry) => total + entry.amountCents, 0);

  if (carried === 0) {
    return `${paid} · quedó como ingreso, no se abona a este precio`;
  }

  return carried === predecessorPaidCents
    ? `${paid} · todo pasó a este contrato`
    : `${paid} · ${formatMoney(cents(carried), money)} pasaron a este contrato`;
}
