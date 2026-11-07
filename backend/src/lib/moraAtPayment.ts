/**
 * Mora in «Registrar un pago»: why each lot owes the mora it owes, and what
 * changing it with the payment files.
 *
 * The owner's rules (2026-11-06):
 *
 * - Under each lot the form says why it has mora: which cuota, when it fell
 *   due, the grace days, and how the amount was worked out.
 * - Whoever holds «Cargar, perdonar o quitar mora» (`mora:charge`) may change
 *   it with the payment: less, none, or more, and «Cobrar mora» on a late lot
 *   that has none. Only on a payment dated today, so no receipt already issued
 *   changes. A reason only when it is changed.
 *
 * Nothing new is counted. Less is a «Perdonar» and more is a «Cargar mora»,
 * the same rows the contract's own mora panel writes, entered just before the
 * payment and linked to its receipt, so voiding the receipt takes them back.
 * lib/mora.ts replays them like any other.
 *
 * Nothing here reads or writes the database.
 */

import type { ContractTerms } from "./contracts.js";
import { buildSchedule } from "./contracts.js";
import type { MoraAccount, MoraForgiveness, MoraManualCharge, MoraRuleVersion } from "./mora.js";
import { rulesOn } from "./mora.js";

/** The prima (0) or one cuota, with where it sits in the price. */
interface Item {
  installment: number;
  dueOn: string;
  startCents: number;
  amountCents: number;
}

function itemsOf(terms: ContractTerms): Item[] {
  const items: Item[] = [];
  let offset = 0;

  if (terms.downPaymentCents > 0) {
    items.push({ installment: 0, dueOn: terms.signedOn, startCents: 0, amountCents: terms.downPaymentCents });
    offset = terms.downPaymentCents;
  }

  for (const entry of buildSchedule(terms)) {
    items.push({ installment: entry.number, dueOn: entry.dueOn, startCents: offset, amountCents: entry.amountCents });
    offset += entry.amountCents;
  }

  return items;
}

/** The day `installment` fell due, or null when the contract has no such cuota. */
export function dueOnOf(terms: ContractTerms, installment: number): string | null {
  return itemsOf(terms).find((item) => item.installment === installment)?.dueOn ?? null;
}

/**
 * The prima or cuota a «Cobrar mora» goes on: the oldest one that fell due
 * before today and is not fully paid. Null when the lot is not late.
 *
 * `pricePaidCents` is what the payments put towards the price: everything
 * paid, less the part that paid mora.
 */
export function oldestLate(
  terms: ContractTerms,
  pricePaidCents: number,
  today: string,
): { installment: number; dueOn: string } | null {
  const late = itemsOf(terms).find(
    (item) => item.dueOn < today && item.startCents + item.amountCents > pricePaidCents,
  );

  return late ? { installment: late.installment, dueOn: late.dueOn } : null;
}

/** How a rule worked a charge out, for saying why. */
export interface ChargeRule {
  calculation: "percent" | "fixed";
  percent: number;
  fixedCents: number;
  capCents: number | null;
  graceDays: number;
}

/** One mora charged and not yet paid or forgiven, with what is needed to say why. */
export interface PendingCharge {
  /** 0 for the prima, otherwise the cuota's number. */
  installment: number;
  /** When that prima or cuota fell due. */
  dueOn: string;
  /** When the mora was charged. */
  incurredOn: string;
  amountCents: number;
  /** What is still owed of it. Less than `amountCents` when part was paid or forgiven. */
  pendingCents: number;
  /** What was unpaid of the cuota that day: the base of a percentage. */
  unpaidCents: number;
  /** Put on by hand («Cargar mora»), not by the rule. */
  manual: boolean;
  /** An automatic charge after the first on the same cuota: «cada mes que siga atrasada». */
  repeat: boolean;
  /** The rule in force that day, for an automatic charge. */
  rule: ChargeRule | null;
}

/**
 * The charges still owed, oldest first, each with the rule that made it.
 * `history` is the contract's own (see `loadContractHistory`).
 */
export function pendingCharges(
  account: MoraAccount | undefined,
  terms: ContractTerms,
  history: readonly MoraRuleVersion[],
): PendingCharge[] {
  if (!account) {
    return [];
  }

  const items = itemsOf(terms);
  const seen = new Set<number>();
  const result: PendingCharge[] = [];

  for (const charge of account.charges) {
    const manual = charge.manualId !== undefined;
    const repeat = !manual && seen.has(charge.installment);

    if (!manual) {
      seen.add(charge.installment);
    }

    const pending = account.pendingByCharge[charge.id] ?? 0;

    if (pending <= 0) {
      continue;
    }

    const rules = manual ? null : rulesOn(history, charge.incurredOn);

    result.push({
      installment: charge.installment,
      dueOn: items.find((item) => item.installment === charge.installment)?.dueOn ?? charge.incurredOn,
      incurredOn: charge.incurredOn,
      amountCents: charge.amountCents,
      pendingCents: pending,
      unpaidCents: charge.unpaidCents,
      manual,
      repeat,
      rule: rules
        ? {
            calculation: rules.calculation,
            percent: rules.percent,
            fixedCents: rules.fixedCents,
            capCents: rules.capCents,
            graceDays: rules.graceDays,
          }
        : null,
    });
  }

  return result;
}

/** What changing a lot's mora with a payment files: «Perdonar» rows for less, one «Cargar mora» for more. */
export interface MoraChange {
  forgive: Array<{ installment: number; amountCents: number }>;
  charge: { installment: number; amountCents: number } | null;
}

/**
 * The rows that leave `targetCents` of mora owed on this lot, right before
 * the payment.
 *
 * Less: forgiven from the oldest charge first, the order payments clear them
 * in, one «Perdonar» per cuota touched. More: one «Cargar mora» for the
 * difference, on the oldest late cuota (`chargeOn`), or failing that on the
 * cuota of the newest mora still owed. A lot with neither is not late, so
 * there is nothing to charge mora for.
 */
export function planMoraChange(
  account: MoraAccount | undefined,
  targetCents: number,
  chargeOn: number | null,
): MoraChange | { problem: string } {
  const pending = account?.pendingCents ?? 0;

  if (targetCents === pending) {
    return { forgive: [], charge: null };
  }

  if (targetCents < pending) {
    let left = pending - targetCents;
    const byInstallment = new Map<number, number>();

    for (const charge of account!.charges) {
      const owed = account!.pendingByCharge[charge.id] ?? 0;

      if (left <= 0 || owed <= 0) {
        continue;
      }

      const share = Math.min(left, owed);
      byInstallment.set(charge.installment, (byInstallment.get(charge.installment) ?? 0) + share);
      left -= share;
    }

    return {
      forgive: [...byInstallment].map(([installment, amountCents]) => ({ installment, amountCents })),
      charge: null,
    };
  }

  const newest = account?.charges.filter((charge) => (account.pendingByCharge[charge.id] ?? 0) > 0).at(-1);
  const installment = chargeOn ?? newest?.installment ?? null;

  if (installment === null) {
    return { problem: "Este lote no tiene cuotas atrasadas; no se le puede cobrar mora." };
  }

  return { forgive: [], charge: { installment, amountCents: targetCents - pending } };
}

/**
 * A change as the rows lib/mora.ts replays: all dated `today`, recorded at
 * `recordedAt`, which is just before the payment's own instant, so the replay
 * puts them before it and after any payment entered earlier that day. The
 * preview and POST /receipts both go through here, so they cannot disagree.
 */
export function changeRows(
  change: MoraChange,
  today: string,
  recordedAt: string,
  newId: () => string,
): { manual: MoraManualCharge[]; forgiveness: MoraForgiveness[] } {
  return {
    manual: change.charge
      ? [{ id: newId(), installment: change.charge.installment, incurredOn: today, amountCents: change.charge.amountCents }]
      : [],
    forgiveness: change.forgive.map((entry) => ({
      id: newId(),
      installment: entry.installment,
      forgivenOn: today,
      recordedAt,
      amountCents: entry.amountCents,
    })),
  };
}

/** One millisecond before `instant`: where a payment's mora change sits in the replay. */
export function justBefore(instant: string): string {
  return new Date(Date.parse(instant) - 1).toISOString();
}
