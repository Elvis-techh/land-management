/**
 * Mora: the late fee on a cuota (or a prima) still unpaid after its grace days.
 *
 * Like every other figure in Lindero, a mora is DERIVED, not stored. It is
 * worked out on read from three things that are themselves facts: the
 * contract's terms, the payments posted against it, and the mora rules in force
 * on each day. That is what lets a payment entered late, or corrected, move the
 * mora with it: a customer who really paid on the 8th was never late, whenever
 * somebody got round to typing it in.
 *
 * The rules agreed with the owner (see the Configuración screen):
 *
 * - Only cuotas falling due on or after «Desde» carry mora. Never backwards.
 * - A cuota is charged the day after its grace days end, on what is STILL
 *   UNPAID of it at that moment: 2 % of a half-paid L 25,000 cuota is 2 % of
 *   L 12,500. A fixed amount is that amount, whatever is unpaid, unless what
 *   is unpaid is under the minimum, when there is one: then nothing.
 * - Once per late cuota, or again every month it stays late, each time on what
 *   is unpaid then. The maximum, when there is one, is per cuota.
 * - The prima carries mora only when the setting says so.
 * - A payment covers the mora first, or the cuotas already due first, as set.
 * - An unpaid mora alone never makes a contract «Atrasado»; that is decided by
 *   the cuotas in lib/contracts.ts, which this file does not change.
 *
 * And the promise on the screen, «una mora ya cobrada no cambia»: the rules are
 * kept as a HISTORY (`MoraRuleVersion`), each version in force from the day
 * after it was saved, and a charge on a given day is worked out with the
 * version in force on that day. Changing the percentage today therefore cannot
 * reach back into a charge made last month, or one made this morning. Only a
 * change to the facts (a payment, a corrected term) re-derives a past charge,
 * exactly as it re-derives every receipt after it.
 *
 * Nothing here reads or writes the database. See lib/moraAccounts.ts for that.
 */

import type { ContractTerms } from "./contracts.js";
import { addMonthsOnDay, buildSchedule, shiftDays } from "./contracts.js";
import { orderLedger } from "./ledger.js";
import type { MoraSettings } from "./settings.js";

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

/** The mora rules as they stood from `effectiveFrom` until the next version. */
export interface MoraRuleVersion {
  /** YYYY-MM-DD. The first day these rules decide a charge or a payment. */
  effectiveFrom: string;
  rules: MoraSettings;
}

/** What this file needs to know about the contract, beyond its terms. */
export interface MoraContract {
  terms: ContractTerms;
  /** "contract" | "reservation". Only a signed contract carries mora. */
  kind: string;
  /**
   * YYYY-MM-DD the contract stopped being serviced (cancelled, defaulted or
   * replaced by an adenda), or null while it is open. Nothing is charged from
   * that day on: a closed contract is not chased for its cuotas, so it is not
   * chased for being late on them either.
   */
  closedOn: string | null;
}

/**
 * Mora put on by hand («Cargar mora»), already checked when it was entered.
 * Removed ones are filtered out before they get here.
 *
 * Charged on its day, for the amount typed, whatever the rules say: the
 * switch, «Desde», the grace days, the frequency and the maximum are all
 * about the automatic mora. Nor does it count towards that maximum.
 */
export interface MoraManualCharge {
  id: string;
  /** 0 for the prima, otherwise the cuota's number. */
  installment: number;
  /** YYYY-MM-DD. */
  incurredOn: string;
  amountCents: number;
}

/** A payment that counts. Reversed ones are filtered out before they get here. */
export interface MoraCredit {
  id: string;
  amountCents: number;
  /** YYYY-MM-DD. */
  paidOn: string;
  createdAt: string;
}

/* -------------------------------------------------------------------------- */
/* Outputs                                                                     */
/* -------------------------------------------------------------------------- */

/** One mora charged on one cuota on one day. */
export interface MoraCharge {
  /** Stable for the same facts, so the ledger orders it the same way every time. */
  id: string;
  /** 0 for the prima, otherwise the cuota's number. */
  installment: number;
  /** YYYY-MM-DD, the day after the grace days ended (or a month after that, and so on). */
  incurredOn: string;
  amountCents: number;
  /** What was still unpaid of the cuota that day: the base of a percentage. */
  unpaidCents: number;
  /** The «Cargar mora» entry this charge is, when it was put on by hand. */
  manualId?: string;
}

/** What one payment paid of the mora, by cuota. */
export interface MoraPaidLine {
  /** 0 for the prima, otherwise the cuota's number. */
  installment: number;
  amountCents: number;
}

/** How one payment was divided between the mora and the price. */
export interface MoraSplit {
  creditId: string;
  paidOn: string;
  /** Went to mora. */
  toMoraCents: number;
  /** Went to the prima and the cuotas, as every payment did before mora existed. */
  toPriceCents: number;
  /** Paid towards the price before and after this payment, for `appliedInstallments`. */
  pricePaidBeforeCents: number;
  pricePaidAfterCents: number;
  /** Which cuotas' mora it paid, oldest charge first. */
  moraPaid: MoraPaidLine[];
  /** Mora charged and not yet paid, right after this payment. */
  moraPendingAfterCents: number;
}

export interface MoraAccount {
  /** Every charge up to `asOf`, in the order they were made. */
  charges: MoraCharge[];
  /** One per counted payment, in ledger order. */
  splits: MoraSplit[];
  chargedCents: number;
  paidCents: number;
  /** Charged and not paid, as of `asOf`. */
  pendingCents: number;
  /**
   * What is still unpaid of each charge, by charge id, for the ones not fully
   * paid. Payments pay the oldest charge first.
   */
  pendingByCharge: Record<string, number>;
}

/* -------------------------------------------------------------------------- */
/* The rules on a given day                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The rules in force on `date`: the latest version that had started by then.
 * `null` before the first version, which is the same as mora switched off.
 */
export function rulesOn(history: readonly MoraRuleVersion[], date: string): MoraSettings | null {
  let found: MoraSettings | null = null;

  for (const version of history) {
    if (version.effectiveFrom > date) {
      break;
    }

    found = version.rules;
  }

  return found;
}

/** Has mora ever been on? When not, nobody owes any and nothing needs working out. */
export function moraEverOn(history: readonly MoraRuleVersion[]): boolean {
  return history.some((version) => version.rules.enabled);
}

/** Does this contract carry mora at all? */
function carriesMora(contract: MoraContract): boolean {
  // A reservation is a hold, not a schedule of cuotas, and a cash sale or a
  // donation has no cuotas to be late on.
  return contract.kind === "contract" && contract.terms.saleType === "financed";
}

/* -------------------------------------------------------------------------- */
/* What can be late                                                            */
/* -------------------------------------------------------------------------- */

/** The prima or one cuota, with where it sits in the price. */
interface Item {
  /** 0 for the prima. */
  installment: number;
  dueOn: string;
  /** Where it starts within the price: the prima first, then cuota 1, 2… */
  startCents: number;
  amountCents: number;
  chargedCents: number;
  charges: number;
}

function itemsOf(terms: ContractTerms): Item[] {
  const items: Item[] = [];
  let offset = 0;

  if (terms.downPaymentCents > 0) {
    items.push({
      installment: 0,
      dueOn: terms.signedOn,
      startCents: 0,
      amountCents: terms.downPaymentCents,
      chargedCents: 0,
      charges: 0,
    });
    offset = terms.downPaymentCents;
  }

  for (const installment of buildSchedule(terms)) {
    items.push({
      installment: installment.number,
      dueOn: installment.dueOn,
      startCents: offset,
      amountCents: installment.amountCents,
      chargedCents: 0,
      charges: 0,
    });
    offset += installment.amountCents;
  }

  return items;
}

/** What is still unpaid of `item` once `pricePaid` has been paid towards the price. */
function unpaidOf(item: Item, pricePaid: number): number {
  const covered = Math.min(item.amountCents, Math.max(0, pricePaid - item.startCents));
  return item.amountCents - covered;
}

/** Do these rules charge mora on this cuota at all? */
function applies(rules: MoraSettings | null, item: Item): rules is MoraSettings {
  return (
    rules !== null &&
    rules.enabled &&
    rules.startsOn !== null &&
    item.dueOn >= rules.startsOn &&
    (item.installment > 0 || rules.chargeDownPayment)
  );
}

/**
 * The first day `item` can be charged, or null if no version of the rules ever
 * charges it.
 *
 * The day after the grace days end, as the rules in force ON THAT DAY count
 * them. When the grace days change while a cuota is waiting, the version in
 * force each day decides, so a charge never lands on a day whose own rules say
 * the cuota was still in its grace.
 */
function firstChargeOn(history: readonly MoraRuleVersion[], item: Item): string | null {
  for (let index = 0; index < history.length; index += 1) {
    const version = history[index]!;

    if (!applies(version.rules, item)) {
      continue;
    }

    const afterGrace = shiftDays(item.dueOn, version.rules.graceDays + 1);
    const day = afterGrace > version.effectiveFrom ? afterGrace : version.effectiveFrom;
    const until = history[index + 1]?.effectiveFrom;

    if (until === undefined || day < until) {
      return day;
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* The replay                                                                  */
/* -------------------------------------------------------------------------- */

interface Pending {
  date: string;
  item: Item;
  /** Set for a charge put on by hand, which is charged once, as typed. */
  manual?: MoraManualCharge;
  /** The first charge day, which the monthly ones count from. */
  anchor: string;
  /** 0 for the first charge, 1 for a month later, and so on. */
  month: number;
}

interface Owed {
  chargeId: string;
  installment: number;
  remainingCents: number;
}

/**
 * Replay one contract: every mora charge up to `asOf`, and how each payment was
 * divided between the mora and the price.
 *
 * One pass in date order, because each step depends on the last: a charge is a
 * percentage of what was unpaid that day, which depends on how earlier payments
 * were divided, which depends on the mora owed when they arrived. On one day,
 * the charge comes before the payments: the charge is for being late up to that
 * day, and a payment that day is already late.
 *
 * With mora never switched on and none put on by hand, every payment goes
 * wholly to the price, which is exactly how the app counted before this file
 * existed.
 */
export function moraAccount(
  contract: MoraContract,
  credits: readonly MoraCredit[],
  history: readonly MoraRuleVersion[],
  asOf: string,
  manual: readonly MoraManualCharge[] = [],
): MoraAccount {
  const ordered = orderLedger(credits);
  const items =
    carriesMora(contract) && (moraEverOn(history) || manual.length > 0)
      ? itemsOf(contract.terms)
      : [];
  const chargeable = (date: string) =>
    date <= asOf && (contract.closedOn === null || date < contract.closedOn);

  // Small (one entry per cuota still waiting), so kept sorted by insertion: by
  // day, and on one day by cuota, so the oldest cuota's mora is always first.
  const queue: Pending[] = [];
  const after = (a: Pending, b: Pending) =>
    a.date > b.date || (a.date === b.date && a.item.installment > b.item.installment);
  const enqueue = (entry: Pending) => {
    let at = queue.length;

    while (at > 0 && after(queue[at - 1]!, entry)) {
      at -= 1;
    }

    queue.splice(at, 0, entry);
  };

  for (const item of items) {
    const first = firstChargeOn(history, item);

    if (first !== null && chargeable(first)) {
      enqueue({ date: first, item, anchor: first, month: 0 });
    }
  }

  for (const entry of manual) {
    const item = items.find((candidate) => candidate.installment === entry.installment);

    if (item && chargeable(entry.incurredOn)) {
      enqueue({ date: entry.incurredOn, item, anchor: entry.incurredOn, month: 0, manual: entry });
    }
  }

  const charges: MoraCharge[] = [];
  const splits: MoraSplit[] = [];
  const owed: Owed[] = [];
  let pricePaid = 0;
  let moraOwed = 0;
  let moraPaidTotal = 0;
  let next = 0;

  const charge = (pending: Pending) => {
    const { item, date } = pending;
    const unpaid = unpaidOf(item, pricePaid);

    if (pending.manual) {
      // Owed as typed, even on a cuota paid by then: it is mora for having
      // been late, and the cuota was late whatever happened after.
      const id = `mora:manual:${pending.manual.id}`;

      charges.push({
        id,
        installment: item.installment,
        incurredOn: date,
        amountCents: pending.manual.amountCents,
        unpaidCents: unpaid,
        manualId: pending.manual.id,
      });
      owed.push({ chargeId: id, installment: item.installment, remainingCents: pending.manual.amountCents });
      moraOwed += pending.manual.amountCents;
      return;
    }

    if (unpaid <= 0) {
      // Paid by then, and payments only add up, so it can never be late again.
      return;
    }

    const rules = rulesOn(history, date);

    if (
      applies(rules, item) &&
      (rules.frequency === "monthly" || item.charges === 0) &&
      (rules.minUnpaidCents === null || unpaid >= rules.minUnpaidCents)
    ) {
      let amount =
        rules.calculation === "fixed"
          ? rules.fixedCents
          : Math.round((unpaid * rules.percent) / 100);

      if (rules.capCents !== null) {
        amount = Math.min(amount, rules.capCents - item.chargedCents);
      }

      if (amount > 0) {
        const id = `mora:${item.installment}:${date}`;

        charges.push({
          id,
          installment: item.installment,
          incurredOn: date,
          amountCents: amount,
          unpaidCents: unpaid,
        });
        item.chargedCents += amount;
        item.charges += 1;
        owed.push({ chargeId: id, installment: item.installment, remainingCents: amount });
        moraOwed += amount;
      }
    }

    // Asked again a month later, whatever today's rules said: the frequency,
    // the maximum or the switch may be different by then.
    const following = addMonthsOnDay(pending.anchor, pending.month + 1, Number(pending.anchor.slice(8, 10)));

    if (chargeable(following)) {
      enqueue({ ...pending, date: following, month: pending.month + 1 });
    }
  };

  const pay = (credit: MoraCredit) => {
    const rules = rulesOn(history, credit.paidOn);
    const amount = credit.amountCents;
    let toMora = 0;

    if (moraOwed > 0) {
      if (rules === null || rules.paymentOrder === "mora") {
        toMora = Math.min(amount, moraOwed);
      } else {
        // The cuotas already due first, then the mora, then any advance.
        const dueNow = items.reduce(
          (total, item) => (item.dueOn <= credit.paidOn ? total + item.amountCents : total),
          0,
        );
        const toDue = Math.min(amount, Math.max(0, dueNow - pricePaid));
        toMora = Math.min(amount - toDue, moraOwed);
      }
    }

    const moraPaid: MoraPaidLine[] = [];
    let left = toMora;

    while (left > 0 && owed.length > 0) {
      const oldest = owed[0]!;
      const share = Math.min(left, oldest.remainingCents);
      const last = moraPaid[moraPaid.length - 1];

      if (last && last.installment === oldest.installment) {
        last.amountCents += share;
      } else {
        moraPaid.push({ installment: oldest.installment, amountCents: share });
      }

      oldest.remainingCents -= share;
      left -= share;

      if (oldest.remainingCents === 0) {
        owed.shift();
      }
    }

    const before = pricePaid;
    pricePaid += amount - toMora;
    moraOwed -= toMora;
    moraPaidTotal += toMora;

    splits.push({
      creditId: credit.id,
      paidOn: credit.paidOn,
      toMoraCents: toMora,
      toPriceCents: amount - toMora,
      pricePaidBeforeCents: before,
      pricePaidAfterCents: pricePaid,
      moraPaid,
      moraPendingAfterCents: moraOwed,
    });
  };

  while (queue.length > 0 || next < ordered.length) {
    const pending = queue[0];
    const credit = ordered[next];

    if (pending && (!credit || pending.date <= credit.paidOn)) {
      queue.shift();
      charge(pending);
    } else {
      pay(credit!);
      next += 1;
    }
  }

  const chargedCents = charges.reduce((total, entry) => total + entry.amountCents, 0);

  return {
    charges,
    splits,
    chargedCents,
    paidCents: moraPaidTotal,
    pendingCents: chargedCents - moraPaidTotal,
    pendingByCharge: Object.fromEntries(owed.map((entry) => [entry.chargeId, entry.remainingCents])),
  };
}

/* -------------------------------------------------------------------------- */
/* Reading an account at a date                                                */
/* -------------------------------------------------------------------------- */

/**
 * Mora paid by payments dated on or before `date`.
 *
 * Valid for any date up to the account's `asOf`, because how a payment was
 * divided depends only on what happened before it.
 */
export function moraPaidThrough(account: MoraAccount, date: string): number {
  return account.splits.reduce(
    (total, split) => (split.paidOn <= date ? total + split.toMoraCents : total),
    0,
  );
}

/** Mora charged on or before `date` and not paid by then. */
export function moraPendingThrough(account: MoraAccount, date: string): number {
  const charged = account.charges.reduce(
    (total, entry) => (entry.incurredOn <= date ? total + entry.amountCents : total),
    0,
  );

  return charged - moraPaidThrough(account, date);
}
