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
 *   that has none. A reason only when it is changed.
 * - On a payment dated today or earlier, as long as no receipt already issued
 *   changes (the owner's rule of 2026-11-12, which replaced «only today»). See
 *   `moraChangeRefusal`. On an earlier date the change is filed on that day,
 *   against the mora the lot owed then, so the history can be typed in oldest
 *   first, Airtable's mora with each payment.
 *
 * Nothing new is counted. Less is a «Perdonar» and more is a «Cargar mora»,
 * the same rows the contract's own mora panel writes, entered just before the
 * payment and linked to its receipt, so voiding the receipt takes them back.
 * lib/mora.ts replays them like any other.
 *
 * Nothing here reads or writes the database.
 */

import type { ContractTerms } from "./contracts.js";
import { buildSchedule, shiftDays } from "./contracts.js";
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
 * The prima or cuota a «Cobrar mora» goes on: the oldest one whose grace days
 * are over and that is not fully paid. Null when the lot is not late.
 *
 * Late from the day the automatic mora would be charged (due + grace + 1, as
 * in lib/mora.ts), not the day after it fell due. Offered sooner, a «Cobrar
 * mora» during the grace days was followed by the automatic charge once they
 * ended: mora twice on the same cuota. The grace days are the ones that also
 * decide «Atrasado» (the owner's rule of 2026-10-22).
 *
 * `pricePaidCents` is what the payments put towards the price: everything
 * paid, less the part that paid mora.
 */
export function oldestLate(
  terms: ContractTerms,
  pricePaidCents: number,
  today: string,
  graceDays: number,
): { installment: number; dueOn: string } | null {
  const late = itemsOf(terms).find(
    (item) => shiftDays(item.dueOn, graceDays) < today && item.startCents + item.amountCents > pricePaidCents,
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

/** One mora charge of a cuota that still owes mora, with what is needed to say why. */
export interface ExplainedCharge {
  /** 0 for the prima, otherwise the cuota's number. */
  installment: number;
  /** When that prima or cuota fell due. */
  dueOn: string;
  /** When the mora was charged. */
  incurredOn: string;
  amountCents: number;
  /** What is still owed of it: 0 once it is paid or forgiven. */
  pendingCents: number;
  /** What «Perdonar» cleared of it. The rest of `amountCents − pendingCents` was paid. */
  forgivenCents: number;
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
 * Every charge of each cuota that still owes mora, oldest first, each with the
 * rule that made it. `history` is the contract's own (see `loadContractHistory`).
 *
 * A cuota's charges come whole, the ones already paid or forgiven too, so the
 * form can add them up: L. 200 + L. 200 + L. 100 reaching a L. 500 maximum,
 * of which L. 200 is already paid. A cuota with nothing left to pay stays out.
 */
export function chargesToExplain(
  account: MoraAccount | undefined,
  terms: ContractTerms,
  history: readonly MoraRuleVersion[],
): ExplainedCharge[] {
  if (!account) {
    return [];
  }

  const items = itemsOf(terms);
  const seen = new Set<number>();
  const result: ExplainedCharge[] = [];

  for (const charge of account.charges) {
    const manual = charge.manualId !== undefined;
    const repeat = !manual && seen.has(charge.installment);

    if (!manual) {
      seen.add(charge.installment);
    }

    if ((account.pendingByInstallment[charge.installment] ?? 0) <= 0) {
      continue;
    }

    const rules = manual ? null : rulesOn(history, charge.incurredOn);

    result.push({
      installment: charge.installment,
      dueOn: items.find((item) => item.installment === charge.installment)?.dueOn ?? charge.incurredOn,
      incurredOn: charge.incurredOn,
      amountCents: charge.amountCents,
      pendingCents: account.pendingByCharge[charge.id] ?? 0,
      forgivenCents: account.forgivenByCharge[charge.id] ?? 0,
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

/** The newest payment still standing on a lot (not voided). */
export interface LatestPayment {
  paidOn: string;
  /** Null for money recorded before there were receipts. */
  receiptCode: string | null;
}

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** «del 5 nov», or «de hoy». */
function dayWords(isoDate: string, today: string): string {
  if (isoDate === today) {
    return "de hoy";
  }

  const [, month, day] = isoDate.split("-");
  return `del ${Number(day)} ${MONTHS[Number(month) - 1] ?? month}`;
}

/**
 * Why a lot's mora cannot be changed with a payment dated `paidOn`, or null
 * when it can. The same words as the form's (frontend moraAtPayment.ts).
 *
 * The rule is the owner's promise that a receipt already handed out never
 * changes. A change is filed on the payment's date, just before it, so:
 *
 * - a receipt dated LATER than the payment would be divided again with the
 *   mora as changed: no change at all;
 * - a receipt dated the SAME day keeps its division when the mora goes down,
 *   because a «Perdonar» sits after the payments already entered that day; but
 *   a «Cargar mora» is a charge, and a day's charges come before its payments
 *   (lib/mora.ts), so charging MORE would make that receipt pay it;
 * - the future has not happened: no change.
 *
 * `raising` when the change would leave more mora owed than there was.
 */
export function moraChangeRefusal(input: {
  paidOn: string;
  today: string;
  latest: LatestPayment | null;
  raising: boolean;
}): string | null {
  const { paidOn, today, latest, raising } = input;

  if (paidOn > today) {
    return "La mora no se cambia en un pago con fecha futura.";
  }

  if (latest === null || latest.paidOn < paidOn || (latest.paidOn === paidOn && !raising)) {
    return null;
  }

  const when = dayWords(latest.paidOn, today);
  const which = latest.receiptCode ? `un recibo ${when} (${latest.receiptCode})` : `un pago ${when}`;

  if (latest.paidOn > paidOn) {
    return (
      `Tiene ${which}, posterior a esta fecha: su mora solo se cambia en un pago ` +
      `${when === "de hoy" ? "de hoy" : `${when} o después`}, para que ese recibo no cambie.`
    );
  }

  return `Ya tiene ${which}: cobrarle más mora ese mismo día cambiaría lo que ese recibo cobró. Cóbrala en un pago de un día posterior.`;
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
 * A change as the rows lib/mora.ts replays: all dated `day`, the payment's
 * date, recorded at `recordedAt`, which is just before the payment's own
 * instant. A «Perdonar» therefore sits right before the payment and after any
 * payment entered earlier that day; a «Cargar mora» is a charge, which comes
 * before all of that day's payments (see `moraChangeRefusal`). The preview and
 * POST /receipts both go through here, so they cannot disagree.
 */
export function changeRows(
  change: MoraChange,
  day: string,
  recordedAt: string,
  newId: () => string,
): { manual: MoraManualCharge[]; forgiveness: MoraForgiveness[] } {
  return {
    manual: change.charge
      ? [{ id: newId(), installment: change.charge.installment, incurredOn: day, amountCents: change.charge.amountCents }]
      : [],
    forgiveness: change.forgive.map((entry) => ({
      id: newId(),
      installment: entry.installment,
      forgivenOn: day,
      recordedAt,
      amountCents: entry.amountCents,
    })),
  };
}

/** One millisecond before `instant`: where a payment's mora change sits in the replay. */
export function justBefore(instant: string): string {
  return new Date(Date.parse(instant) - 1).toISOString();
}
