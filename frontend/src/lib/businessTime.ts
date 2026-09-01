/**
 * What day it is, as far as the BUSINESS is concerned.
 *
 * Lindero is full of calendar DATES rather than instants: the day a payment was
 * received, the day a contract was signed, the day an installment falls due.
 * Each of those is a fact about a day in the office, so they all have to be
 * decided in one place's calendar — the office's — or the screens disagree with
 * each other and with the paper.
 *
 * Two spellings of "today" were wrong here before this file existed, and both
 * had already been written twice:
 *
 *  - `new Date().toISOString().slice(0, 10)` reads the date in UTC. From six in
 *    the evening in Tegucigalpa onwards that is already tomorrow, so a receipt
 *    written at half past nine at night defaulted to the next day.
 *  - The DEVICE's own timezone is right on a laptop set to Honduras and wrong on
 *    one that is not — a machine left on UTC, or a phone that followed somebody
 *    abroad. The office's books should not move because a laptop travelled.
 *
 * So the zone is stated once, by the SERVER, and this file is told it.
 */

/**
 * The zone to use until the server has said otherwise.
 *
 * Only ever in force for the moment between the first paint and the session
 * response landing, and only matters if something formats a date in that
 * window. It is the same default `TIME_ZONE` has in backend/src/config/env.ts —
 * but it is a fallback, not a second source of truth: the server's answer
 * always replaces it, so setting TIME_ZONE on the server needs no change here.
 */
const FALLBACK_TIME_ZONE = "America/Tegucigalpa";

let timeZone = FALLBACK_TIME_ZONE;

/*
 * Rebuilt only when the zone changes.
 *
 * Constructing an `Intl.DateTimeFormat` is the expensive part of formatting a
 * date, and `businessToday` is called on every dialog open and every render of
 * a list of timestamps.
 *
 * Asked for the PARTS rather than handed a locale that happens to print in ISO
 * order. "en-CA" does produce YYYY-MM-DD today, but that is a property of a
 * locale's formatting conventions rather than a guarantee, and a date-ordering
 * change in some future browser must not silently swap the day and the month in
 * a value that gets posted to the server.
 */
let formatter = buildFormatter(timeZone);

function buildFormatter(zone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/**
 * Adopt the zone the server reported with the session.
 *
 * A zone the browser does not recognise is ignored rather than allowed to
 * throw: an app that refuses to render because of a configuration typo is worse
 * than one that keeps using the previous zone, and the server has already
 * refused to boot on a name `Intl` rejects.
 */
export function setBusinessTimeZone(zone: string): void {
  if (zone === timeZone) {
    return;
  }

  try {
    formatter = buildFormatter(zone);
    timeZone = zone;
  } catch {
    // Keep whatever was working before.
  }
}

/** The office's timezone, for formatters that need to be handed one. */
export function businessTimeZone(): string {
  return timeZone;
}

/** Today in the office's calendar, as "2026-08-31". */
export function businessToday(now: Date = new Date()): string {
  const parts = formatter.formatToParts(now);
  const find = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${find("year")}-${find("month")}-${find("day")}`;
}

/** The current year in the office's calendar — for "cliente desde". */
export function businessYear(now: Date = new Date()): number {
  return Number(businessToday(now).slice(0, 4));
}

/**
 * Whole days between two instants, counted as CALENDAR days in the office.
 *
 * Not `(a - b) / 86_400_000`, which counts elapsed time: something that
 * happened at nine last night is 15 hours ago, and that arithmetic calls it
 * "today" until nine tonight. A person asking when somebody last signed in
 * means days on a calendar, not multiples of twenty-four hours.
 */
export function calendarDaysBetween(from: Date, to: Date): number {
  const asUtcNoon = (date: Date) => {
    const [year, month, day] = businessToday(date).split("-").map(Number);

    // Midday rather than midnight so the subtraction cannot be tipped either
    // way by a leap second or a historical offset change of a few minutes.
    return Date.UTC(year!, month! - 1, day!, 12);
  };

  return Math.round((asUtcNoon(to) - asUtcNoon(from)) / 86_400_000);
}
