/**
 * Gives every project a stable accent colour, used for the dot next to the
 * project name in tables.
 *
 * Colours are assigned by the project's position in the alphabetically sorted
 * list of projects on screen. That guarantees the projects get *different*
 * colours (up to ACCENT_COUNT of them), which a hash cannot promise — a hash of
 * four names will happily give two of them the same colour.
 *
 * Sorting, rather than order-of-appearance, keeps a project's colour stable no
 * matter how the table happens to be ordered or filtered.
 *
 * These colours are deliberately NOT the status colours (green / amber / red).
 * A green dot must never be confused with a "Disponible" stamp — one is a
 * category, the other is meaning.
 */
const ACCENT_COUNT = 5;

/**
 * Build the project-name → CSS-class lookup for a set of rows.
 * Call this once per render, not once per row.
 */
export function buildProjectAccents(projectNames: string[]): Map<string, string> {
  const distinctSorted = [...new Set(projectNames)].sort((a, b) => a.localeCompare(b, "es"));

  return new Map(
    distinctSorted.map((name, index) => [name, `proj-accent-${index % ACCENT_COUNT}`]),
  );
}
