/**
 * Suggesting the next lot number.
 *
 * A lot code is a PREFIX and a NUMBER — "A-06" is prefix "A", number 6. The two
 * are kept apart in the form so the suggestion can work: change the prefix and
 * the number re-derives for that prefix, which is impossible if the code is one
 * opaque string.
 *
 * Nothing here is authoritative. The database's unique index on
 * (project, code) is what actually prevents duplicates; this only saves typing,
 * and the user may overwrite every part of it.
 */

/** A code that splits cleanly into letters and digits. Codes that do not — the
 * manual escape hatch in the form — simply never reach these functions. */
export interface ParsedLotCode {
  /** The letters, upper-cased, e.g. "A" or "AB". */
  prefix: string;
  number: number;
  /** How many digits the number was written with, so "06" stays "06". */
  width: number;
}

/**
 * Split "A-06" into its parts, or return `null` if it does not have this shape.
 *
 * The separator is optional and may be a dash, a space, or nothing at all, so
 * "A-06", "A 6" and "A06" are all understood. Anything else — "LOTE 12B",
 * "esquina norte" — is left alone rather than guessed at.
 */
export function parseLotCode(code: string): ParsedLotCode | null {
  const match = /^([A-Za-zÑñ]+)[\s-]*(\d+)$/.exec(code.trim());

  if (!match || match[1] === undefined || match[2] === undefined) {
    return null;
  }

  return {
    prefix: match[1].toUpperCase(),
    number: Number(match[2]),
    width: match[2].length,
  };
}

/** Join the parts back into the code that will be saved. */
export function formatLotCode(prefix: string, numberText: string): string {
  const cleanPrefix = prefix.trim().toUpperCase();
  const cleanNumber = numberText.trim();

  if (!cleanPrefix) {
    return cleanNumber;
  }
  if (!cleanNumber) {
    return cleanPrefix;
  }

  return `${cleanPrefix}-${cleanNumber}`;
}

/**
 * The prefixes already in use in a project, most-used first.
 *
 * These become the one-click chips in the form. Only prefixes that exist are
 * offered — inventing "D" because "A", "B" and "C" are taken would be guessing
 * at a naming scheme that belongs to the business, not to this app.
 */
export function prefixesInUse(codes: string[]): string[] {
  const counts = new Map<string, number>();

  for (const code of codes) {
    const parsed = parseLotCode(code);
    if (parsed) {
      counts.set(parsed.prefix, (counts.get(parsed.prefix) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([prefix]) => prefix);
}

/**
 * The number to suggest for `prefix`, as text, padded to match what is there.
 *
 * Highest + 1, not count + 1: gaps in the numbering are normal — a lot gets
 * archived, a number is skipped — and reusing a gap would collide with an
 * archived lot the user cannot see. A prefix with no lots yet starts at "01",
 * matching the two-digit habit the codes already show.
 */
export function suggestNextNumber(codes: string[], prefix: string): string {
  const target = prefix.trim().toUpperCase();

  if (!target) {
    return "";
  }

  let highest = 0;
  let width = 2;

  for (const code of codes) {
    const parsed = parseLotCode(code);

    if (parsed && parsed.prefix === target && parsed.number >= highest) {
      highest = parsed.number;
      width = parsed.width;
    }
  }

  return String(highest + 1).padStart(width, "0");
}

/**
 * The prefix to start the form on for a project: the one its highest-numbered
 * lot uses, so adding lots in order needs no clicks at all.
 */
export function suggestPrefix(codes: string[]): string {
  const used = prefixesInUse(codes);

  if (used.length === 0) {
    return "A";
  }

  let best = used[0] ?? "A";
  let highest = -1;

  for (const code of codes) {
    const parsed = parseLotCode(code);
    if (parsed && parsed.number > highest) {
      highest = parsed.number;
      best = parsed.prefix;
    }
  }

  return best;
}
