import type { Cents, MoneyView } from "../../lib/money";

/**
 * How the Panel General words itself, defined once.
 *
 * The same month, the same comparison and the same collection rate appear in a
 * heading, a stat tile and a chart label, and the only way to guarantee all
 * three say the same thing is to have one copy of each.
 */

/*
 * Months are handled as "YYYY-MM" strings and split by hand, never handed to
 * `new Date(value)` — which reads a bare date as UTC midnight and then prints it
 * in the local zone, turning "2026-03" into February for everyone west of
 * Greenwich, Honduras included.
 */
const MONTH_NAMES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

const MONTH_ABBREVIATIONS = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sep",
  "oct",
  "nov",
  "dic",
];

function monthIndex(month: string): number {
  return Number(month.slice(5, 7)) - 1;
}

/** "septiembre 2026". */
export function formatMonth(month: string): string {
  return `${MONTH_NAMES[monthIndex(month)] ?? month} ${month.slice(0, 4)}`;
}

/** "septiembre" — for a sentence that has already established the year. */
export function formatMonthName(month: string): string {
  return MONTH_NAMES[monthIndex(month)] ?? month;
}

/**
 * "sep", or "sep 26" in January and for the first column of a chart.
 *
 * The year appears only where the axis crosses into a new one, so a twelve-month
 * axis says it once or twice rather than twelve times.
 */
export function formatMonthAxis(month: string, isFirst: boolean): string {
  const abbreviation = MONTH_ABBREVIATIONS[monthIndex(month)] ?? month;

  return isFirst || monthIndex(month) === 0
    ? `${abbreviation} ${month.slice(2, 4)}`
    : abbreviation;
}

/**
 * An amount short enough for a chart's axis: "L 340 k", "$ 1.2 M".
 *
 * Rounded on purpose, and only ever used on a gridline. An axis is a sense of
 * scale, not a figure anybody quotes — the exact amount is in the readout above
 * the chart and in the table below it, both to the centavo.
 *
 * Goes through the same `MoneyView` as every other amount on screen, so the
 * axis follows the currency toggle instead of quietly staying in lempiras.
 */
export function compactMoney(amount: Cents, view: MoneyView): string {
  const units = view.currency === "USD" ? amount / 100 / view.usdRate : amount / 100;
  const symbol = view.currency === "USD" ? "$" : "L";

  if (Math.abs(units) >= 1_000_000) {
    return `${symbol} ${(units / 1_000_000).toFixed(1)} M`;
  }

  if (Math.abs(units) >= 1_000) {
    return `${symbol} ${Math.round(units / 1_000)} k`;
  }

  return `${symbol} ${Math.round(units)}`;
}

/* -------------------------------------------------------------------------- */
/* Comparisons                                                                 */
/* -------------------------------------------------------------------------- */

/** Which way a change points. Every use of this on the screen is "up is good". */
export type DeltaTone = "up" | "down" | "flat";

export interface Delta {
  tone: DeltaTone;
  /** "+18 %", "−7 %", "sin cambio", or "sin comparación". */
  label: string;
}

/**
 * This month against last, as a percentage.
 *
 * `unknown` rather than "+100 %" when the previous month was zero, which is the
 * case that makes every naive percentage-change function lie: the first month a
 * project collects anything is not infinite growth, and a business that took a
 * month off did not improve by 100 % on its return.
 */
export function compareToPrevious(current: number, previous: number): Delta {
  if (previous === 0) {
    return {
      tone: current > 0 ? "up" : "flat",
      label: current > 0 ? "sin comparación" : "sin cambio",
    };
  }

  const change = Math.round(((current - previous) / previous) * 100);

  if (change === 0) {
    return { tone: "flat", label: "sin cambio" };
  }

  // A true minus sign, not a hyphen: these sit beside figures, and a hyphen at
  // this size reads as a dash between two numbers rather than as a sign.
  return {
    tone: change > 0 ? "up" : "down",
    label: `${change > 0 ? "+" : "−"}${Math.abs(change)} %`,
  };
}

/** How many days a month has. Built through UTC, like every other date here. */
export function daysInMonth(month: string): number {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
}

/**
 * What the month-over-month figure is actually comparing.
 *
 * Halfway through September the comparison is against the first fifteen days of
 * August, not against August — and saying so is the difference between a reader
 * trusting the number and a reader wondering why the business collapsed.
 * Once the span covers the whole of the previous month it says the plain thing.
 */
export function describeComparison(previousMonth: string, comparisonDays: number): string {
  const name = formatMonthName(previousMonth);

  if (comparisonDays >= daysInMonth(previousMonth)) {
    return `frente a ${name}`;
  }

  // "los primeros 1 días" is what a template gets you on the first of the month,
  // which is exactly the day this sentence is read most.
  if (comparisonDays === 1) {
    return `frente al primer día de ${name}`;
  }

  return `frente a los primeros ${comparisonDays} días de ${name}`;
}

/**
 * How much of what was scheduled actually arrived, as a percentage.
 *
 * NOT capped at 100. A month where customers paid ahead genuinely collected
 * 184 % of what was due, and that is the good news the screen exists to
 * deliver — reporting it as a flat "100 %" would hide the best month of the
 * year behind the same figure as a month that merely broke even. It is the
 * METER that clamps its own width, because a bar running past its track reads
 * as a rendering bug; the number beside it stays true.
 *
 * `null` when nothing was scheduled — a month with no installments falling due
 * has no collection rate, and rendering that as 0 % would report a quiet month
 * as a failed one.
 */
export function collectionRate(collected: Cents, expected: Cents): number | null {
  if (expected <= 0) {
    return null;
  }

  return Math.round((collected / expected) * 100);
}

/** "14 clientes", "1 cliente" — Spanish plurals the app writes out by hand. */
export function pluralise(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/*
 * Dates arrive as plain YYYY-MM-DD calendar dates, never as instants — the same
 * rule and the same reason as features/contracts/contractPresentation.ts.
 */

/** "05 mar 2026". */
export function formatDate(isoDate: string | null): string {
  if (!isoDate) {
    return "—";
  }

  const [year, month, day] = isoDate.split("-");

  if (!year || !month || !day) {
    return isoDate;
  }

  return `${day} ${MONTH_ABBREVIATIONS[Number(month) - 1] ?? month} ${year}`;
}

/**
 * Whole days from `from` to `to`; negative when `to` is already past.
 *
 * Both sides are parsed as UTC so the answer cannot change with the reader's
 * timezone, which is the same reason the server does its date arithmetic in UTC.
 */
export function daysBetween(from: string, to: string): number {
  const parse = (date: string) =>
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));

  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

/** "vence en 6 días", "venció hace 3 días", "vence hoy". */
export function describeExpiry(expiresOn: string, asOf: string): string {
  const days = daysBetween(asOf, expiresOn);

  if (days === 0) {
    return "vence hoy";
  }

  if (days < 0) {
    return `venció hace ${pluralise(Math.abs(days), "día", "días")}`;
  }

  return `vence en ${pluralise(days, "día", "días")}`;
}
