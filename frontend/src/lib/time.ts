/**
 * Reading the two timestamp shapes the API sends back.
 *
 * A mirror of `backend/src/lib/time.ts`, and for the same reason: rows written
 * by the application carry a full ISO-8601 string with a `Z`
 * ("2026-08-30T01:23:45.678Z"), while rows written by a column's
 * `CURRENT_TIMESTAMP` default carry SQLite's own format, which is UTC but says
 * so nowhere ("2026-08-30 15:02:23"). Both reach the browser exactly as stored.
 *
 * Two things go wrong if that is ignored. Handed to `new Date()`, the second
 * shape is read as LOCAL time and quietly shifts by the timezone offset.
 * Compared as plain strings, every space-form row sorts before every T-form row
 * on the same day, because `' ' < 'T'`.
 */
export function parseTimestamp(value: string): number {
  const trimmed = value.trim();

  // Already carries a zone — ISO with Z, or with a +hh:mm / -hh:mm offset.
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed);
  const normalised = hasZone ? trimmed : `${trimmed.replace(" ", "T")}Z`;

  return new Date(normalised).getTime();
}
