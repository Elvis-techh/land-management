/**
 * Reading the two timestamp shapes this database contains.
 *
 * Rows written by the application carry a full ISO-8601 string with a `Z`
 * ("2026-08-28T01:23:45.678Z"). Rows written by a column's `CURRENT_TIMESTAMP`
 * default carry SQLite's own format, which is UTC but says so nowhere
 * ("2026-08-26 15:02:23"). Handed to `new Date()` the second one is read as
 * LOCAL time, which quietly shifts it by the timezone offset.
 *
 * So both are normalised here, in one place, rather than at each call site.
 */
export function parseTimestamp(value: string): number {
  const trimmed = value.trim();

  // Already carries a zone — ISO with Z, or with a +hh:mm / -hh:mm offset.
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed);
  const normalised = hasZone ? trimmed : `${trimmed.replace(" ", "T")}Z`;

  return new Date(normalised).getTime();
}
