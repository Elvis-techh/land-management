/**
 * The arithmetic of a contract: when money is due, and whether it arrived.
 *
 * Everything here is a pure function of the contract's agreed terms plus the
 * payments actually posted against it. Nothing in this file reads or writes the
 * database, and nothing it produces is ever stored — a saved "payment alert
 * status" is stale by the following morning, which is exactly how a spreadsheet
 * ends up reassuring somebody about a customer who stopped paying in March.
 *
 * The business rules, agreed with the owner:
 *
 * - An installment is not late until FIVE days after its due date.
 * - Two months behind is no longer merely late; it needs attention.
 * - Everything is denominated in lempiras. A customer who pays in dollars has
 *   the bank's actual rate for that day recorded on the payment itself, so the
 *   accounts are built from what was really received rather than from today's
 *   display rate applied backwards.
 */

/** Days after the due date before an installment counts as late. */
export const GRACE_DAYS = 5;

/** Months behind at which a contract stops being merely late. */
export const AT_RISK_MONTHS = 2;

/** How early an upcoming installment starts showing as "por vencer". */
export const DUE_SOON_DAYS = 7;

const DAY_MS = 86_400_000;

/** "financed" — installments; "cash" — settled at signing; "donation" — no money. */
export type SaleType = "financed" | "cash" | "donation";

export type PaymentHealth = "current" | "due_soon" | "overdue" | "at_risk";

/**
 * The terms this file needs. A subset of the contracts row on purpose: it keeps
 * the arithmetic testable without building a whole database record, and makes
 * it obvious that no other column influences a due date.
 */
export interface ContractTerms {
  saleType: SaleType;
  salePriceCents: number;
  downPaymentCents: number;
  termMonths: number | null;
  monthlyPaymentCents: number | null;
  dueDay: number | null;
  /** YYYY-MM-DD. The date the schedule counts from. */
  signedOn: string;
  /** YYYY-MM-DD, when the first installment was negotiated separately. */
  firstDueOn?: string | null;
}

export interface ScheduledInstallment {
  /** YYYY-MM-DD. */
  dueOn: string;
  amountCents: number;
  /** 1-based, as a person would say it: "la cuota 7 de 24". */
  number: number;
}

/* -------------------------------------------------------------------------- */
/* Dates                                                                       */
/* -------------------------------------------------------------------------- */

/*
 * Calendar dates are handled as UTC milliseconds throughout. Parsing
 * "2026-03-05" with `new Date()` in a browser or a server set to Tegucigalpa
 * yields the 4th at 18:00 local, and a due date that moves depending on where
 * the code runs is not a due date.
 */

function utcDay(isoDate: string): number {
  return Date.UTC(
    Number(isoDate.slice(0, 4)),
    Number(isoDate.slice(5, 7)) - 1,
    Number(isoDate.slice(8, 10)),
  );
}

function toIsoDate(millis: number): string {
  return new Date(millis).toISOString().slice(0, 10);
}

function daysInMonth(year: number, monthIndex: number): number {
  // Day 0 of the following month is the last day of this one.
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((utcDay(to) - utcDay(from)) / DAY_MS);
}

export function shiftDays(isoDate: string, days: number): string {
  return toIsoDate(utcDay(isoDate) + days * DAY_MS);
}

/**
 * The same day-of-month, `months` later, clamped to months that are too short
 * to have one.
 *
 * A contract with a due day of the 31st still falls due in February, and it
 * falls due on the 28th — or the 29th in a leap year. Letting the date roll
 * forward into March instead, which is what naive month arithmetic does, would
 * silently grant an extra three days every February and put the schedule out of
 * step with the paper contract for the rest of its life.
 */
export function addMonthsOnDay(isoDate: string, months: number, day: number): string {
  // Month overflow past December rolls the year over on its own.
  const target = new Date(
    Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1 + months, 1),
  );
  const targetYear = target.getUTCFullYear();
  const targetMonth = target.getUTCMonth();

  return toIsoDate(
    Date.UTC(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth))),
  );
}

/**
 * When the first installment falls due.
 *
 * Default: one whole month after signing, on the agreed due day. Signing on
 * 15 January with a due day of the 5th means the first installment is due on
 * 5 February, not three weeks after the customer handed over the prima.
 *
 * `firstDueOn` overrides it, because this is genuinely negotiated — "empezamos
 * a pagar en enero" is a normal thing to agree to, and a rule cannot guess it.
 */
export function firstDueDate(terms: ContractTerms): string | null {
  if (terms.firstDueOn) {
    return terms.firstDueOn;
  }

  if (terms.dueDay === null) {
    return null;
  }

  return addMonthsOnDay(terms.signedOn, 1, terms.dueDay);
}

/* -------------------------------------------------------------------------- */
/* The schedule                                                                */
/* -------------------------------------------------------------------------- */

/** What is financed after the prima: the part being paid in installments. */
export function financedCents(terms: Pick<ContractTerms, "salePriceCents" | "downPaymentCents">) {
  return Math.max(0, terms.salePriceCents - terms.downPaymentCents);
}

/**
 * The installments, derived rather than stored.
 *
 * There is no payment-schedule table yet, and there should not be one until
 * contracts can be restructured: a generated schedule cannot drift from the
 * terms it was generated from, whereas a stored one silently can, and then two
 * screens disagree about when a customer is due.
 *
 * The LAST installment absorbs the rounding. An agreed L 3,500 a month over 24
 * months against L 84,300 financed leaves L 300 unaccounted for, and it is the
 * final payment that is short or long — never a fractional monthly nobody could
 * hand over at a window.
 */
export function buildSchedule(terms: ContractTerms): ScheduledInstallment[] {
  if (terms.saleType !== "financed") {
    return [];
  }

  const months = terms.termMonths ?? 0;
  const monthly = terms.monthlyPaymentCents ?? 0;
  const first = firstDueDate(terms);

  if (months < 1 || monthly < 1 || first === null || terms.dueDay === null) {
    return [];
  }

  const financed = financedCents(terms);
  const schedule: ScheduledInstallment[] = [];
  let placed = 0;

  for (let index = 0; index < months; index += 1) {
    const isLast = index === months - 1;
    // Whatever is left on the final one, so the schedule sums to exactly the
    // financed amount rather than to monthly × months.
    const amountCents = isLast ? Math.max(0, financed - placed) : Math.min(monthly, financed - placed);

    if (amountCents <= 0 && !isLast) {
      // The agreed monthly has already covered the whole financed amount, so
      // the remaining installments are not owed. Stop rather than list zeros.
      break;
    }

    placed += amountCents;
    schedule.push({
      number: index + 1,
      dueOn: addMonthsOnDay(first, index, terms.dueDay),
      amountCents,
    });
  }

  return schedule;
}

/**
 * How much the contract says should have been received by `asOf`.
 *
 * The prima counts from the signing date; installments count from their due
 * dates. A cash sale expects the whole price at signing, and a donation expects
 * nothing, ever.
 */
function expectedByCents(terms: ContractTerms, schedule: ScheduledInstallment[], asOf: string) {
  if (terms.saleType === "donation") {
    return 0;
  }

  if (utcDay(asOf) < utcDay(terms.signedOn)) {
    return 0;
  }

  if (terms.saleType === "cash") {
    return terms.salePriceCents;
  }

  let expected = terms.downPaymentCents;

  for (const installment of schedule) {
    if (utcDay(installment.dueOn) <= utcDay(asOf)) {
      expected += installment.amountCents;
    }
  }

  return Math.min(expected, terms.salePriceCents);
}

/* -------------------------------------------------------------------------- */
/* Payment health                                                              */
/* -------------------------------------------------------------------------- */

export interface HealthReport {
  status: PaymentHealth;
  /** Sale price minus everything posted. Negative is impossible by construction. */
  balanceCents: number;
  /** What is late right now, after the grace period. Zero when up to date. */
  arrearsCents: number;
  /** Whole months of arrears, as somebody would say it out loud. */
  monthsBehind: number;
  /** Whole months paid in advance. Customers here routinely pay two at once. */
  monthsAhead: number;
  /** The next installment falling due, or null once the term is over. */
  nextDueOn: string | null;
  nextDueAmountCents: number;
  /** Nothing further is owed. Kept apart from the contract's own lifecycle. */
  settled: boolean;
}

/**
 * Where this contract stands today.
 *
 * Note the two different expectations, which is the part worth reading twice:
 *
 * - Arrears are measured against what was due AFTER the five-day grace, so a
 *   customer who pays on the 8th for a due date of the 5th is never called
 *   late.
 * - Being ahead is measured against the plain schedule, with no grace. Using
 *   the graced figure for both would announce that somebody who paid exactly on
 *   their due date is a month ahead, every month, for the life of the contract.
 */
export function assessContract(
  terms: ContractTerms,
  paidToDateCents: number,
  asOf: string,
): HealthReport {
  const schedule = buildSchedule(terms);
  const balanceCents = Math.max(0, terms.salePriceCents - paidToDateCents);
  const settled = terms.salePriceCents - paidToDateCents <= 0;

  const dueBySchedule = expectedByCents(terms, schedule, asOf);
  const dueAfterGrace = expectedByCents(terms, schedule, shiftDays(asOf, -GRACE_DAYS));

  const arrearsCents = settled ? 0 : Math.max(0, dueAfterGrace - paidToDateCents);
  const aheadCents = Math.max(0, paidToDateCents - dueBySchedule);

  // A cash sale or a donation has no monthly, so arrears cannot be counted in
  // months. Any arrears at all on one of those is a single overdue debt.
  const monthly = terms.monthlyPaymentCents ?? 0;
  const monthsBehind =
    monthly > 0 ? Math.ceil(arrearsCents / monthly) : arrearsCents > 0 ? 1 : 0;
  const monthsAhead = monthly > 0 ? Math.floor(aheadCents / monthly) : 0;

  // The next installment MONEY IS STILL OWED ON, which is not the same as the
  // next one on the calendar. A customer who pays three months at once has
  // nothing to do in months two and three, and telling them a payment is due
  // next week is how an app teaches people to ignore it.
  let uncovered = Math.max(0, paidToDateCents - terms.downPaymentCents);
  let upcoming: ScheduledInstallment | undefined;

  for (const installment of schedule) {
    if (uncovered >= installment.amountCents) {
      uncovered -= installment.amountCents;
      continue;
    }

    upcoming = installment;
    break;
  }

  // What is left of it, so a part-paid installment asks for the difference
  // rather than for the whole amount again.
  const nextDueAmountCents = upcoming ? upcoming.amountCents - uncovered : 0;

  let status: PaymentHealth = "current";

  if (monthsBehind >= AT_RISK_MONTHS) {
    status = "at_risk";
  } else if (monthsBehind >= 1) {
    status = "overdue";
  } else if (
    !settled &&
    upcoming !== undefined &&
    daysBetween(asOf, upcoming.dueOn) <= DUE_SOON_DAYS
  ) {
    status = "due_soon";
  }

  return {
    status,
    balanceCents,
    arrearsCents,
    monthsBehind,
    monthsAhead,
    nextDueOn: settled ? null : (upcoming?.dueOn ?? null),
    nextDueAmountCents: settled ? 0 : nextDueAmountCents,
    settled,
  };
}
