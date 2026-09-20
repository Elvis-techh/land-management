/**
 * Multi-level sorting — "by customer, then by project" — shared by every
 * screen's sort menu (Recibos, Contratos, Lotes, Clientes).
 *
 * A screen's sort used to be one field and one direction. It is now a list of
 * `SortRule`s tried in order: the first one that tells two rows apart decides
 * where they go, and only a tie falls through to the next. `[]` never happens
 * in practice — every screen's `DEFAULT_SORT` is a one-rule list — but nothing
 * here assumes it; an empty list just means "everything ties", which is
 * exactly right.
 *
 * See components/SortMenu.tsx for the picker this drives.
 */

export type SortDirection = "asc" | "desc";

export interface SortRule<Field extends string> {
  field: Field;
  direction: SortDirection;
}

/**
 * Run `rules` in order and return the first non-zero comparison. `0` when
 * every rule ties, which is a real answer — the caller's own final tie-break
 * (customer name, code, whatever keeps the list stable) picks up from there,
 * exactly as it did before multi-level sort existed.
 *
 * `compareField` gets the whole rule, not just the field, and OWNS applying
 * its direction — rather than this function flipping the sign for it. Most
 * fields just want `(a.x - b.x) * (rule.direction === "asc" ? 1 : -1)`, but
 * not all of them: a lot with nobody on it has to sink to the bottom of
 * "Cliente" whichever way that column is sorted, which is not something a
 * single number can express both signs of at once. Handing over the whole
 * rule lets a field like that decide when direction applies to it and when it
 * doesn't, instead of forcing every field through the same flip.
 */
export function compareByRules<T, Field extends string>(
  a: T,
  b: T,
  rules: ReadonlyArray<SortRule<Field>>,
  compareField: (a: T, b: T, rule: SortRule<Field>) => number,
): number {
  for (const rule of rules) {
    const result = compareField(a, b, rule);

    if (result !== 0) {
      return result;
    }
  }

  return 0;
}

/* -------------------------------------------------------------------------- */
/* Editing a rule list                                                        */
/* -------------------------------------------------------------------------- */
/*
 * Plain functions rather than logic inlined in components/SortMenu.tsx, so the
 * one thing about a multi-row editor that is easy to get subtly wrong — what
 * happens when the SAME field is chosen at two levels — is something a test
 * can hold onto instead of something that only shows up by clicking around.
 */

/**
 * Make `field` the PRIMARY rule. This is what clicking an entry in the
 * "Ordenar por" list does — it never adds a level; only "Agregar otro orden"
 * does that.
 *
 * Picking the field already primary flips its direction — the shortcut every
 * screen's sort menu already trained people on, kept the same now that there
 * can be more than one level.
 *
 * Picking a field that was already a SECONDARY level moves it to the front
 * rather than leaving both a promoted rule and the old one behind it —
 * sorting by "Lote" twice, first and second, means nothing, and it is exactly
 * what forgetting this case produces. It keeps the direction it already had
 * there: the user already chose that, and promoting it should not silently
 * discard the choice the way starting a level fresh does. The OLD primary
 * takes the vacated slot, so this reads as swapping the two rather than as
 * throwing the first one away — the level count does not change.
 *
 * Picking a field used at NEITHER level replaces the primary outright — the
 * old primary is simply gone, the way choosing a different field always
 * worked before multi-level sort existed. Any other secondary levels are left
 * untouched: they were added on purpose, and changing the primary should not
 * as a side effect invent a new one out of whatever it replaced.
 */
export function promoteField<Field extends string>(
  rules: ReadonlyArray<SortRule<Field>>,
  field: Field,
  defaultDirection: (field: Field) => SortDirection,
): SortRule<Field>[] {
  const primary = rules[0];

  if (primary?.field === field) {
    return [{ field, direction: primary.direction === "asc" ? "desc" : "asc" }, ...rules.slice(1)];
  }

  const existingIndex = rules.findIndex((rule) => rule.field === field);

  if (existingIndex === -1) {
    return [{ field, direction: defaultDirection(field) }, ...rules.slice(1)];
  }

  const promoted = rules[existingIndex]!;
  const rest = rules.filter((_, index) => index !== existingIndex);

  return [promoted, ...rest];
}

/** Change which field one level sorts by, resetting it to that field's default direction. */
export function setLevelField<Field extends string>(
  rules: ReadonlyArray<SortRule<Field>>,
  level: number,
  field: Field,
  defaultDirection: (field: Field) => SortDirection,
): SortRule<Field>[] {
  const next = [...rules];

  next[level] = { field, direction: defaultDirection(field) };

  return next;
}

/** Flip one level's direction, leaving its field and every other level alone. */
export function toggleLevelDirection<Field extends string>(
  rules: ReadonlyArray<SortRule<Field>>,
  level: number,
): SortRule<Field>[] {
  const next = [...rules];
  const rule = next[level];

  if (rule) {
    next[level] = { ...rule, direction: rule.direction === "asc" ? "desc" : "asc" };
  }

  return next;
}

/** Drop one level. Never the only way to change the primary field — see `promoteField`. */
export function removeLevel<Field extends string>(
  rules: ReadonlyArray<SortRule<Field>>,
  level: number,
): SortRule<Field>[] {
  return rules.filter((_, index) => index !== level);
}

/**
 * Append a new level for the first option not already in use at any level.
 * A no-op if every option is already spoken for — sorting by the same field
 * twice has no meaning, so there is nothing left to add.
 */
export function addLevel<Field extends string>(
  rules: ReadonlyArray<SortRule<Field>>,
  options: ReadonlyArray<{ field: Field }>,
  defaultDirection: (field: Field) => SortDirection,
): SortRule<Field>[] {
  const used = new Set(rules.map((rule) => rule.field));
  const next = options.find((option) => !used.has(option.field));

  return next ? [...rules, { field: next.field, direction: defaultDirection(next.field) }] : [...rules];
}
