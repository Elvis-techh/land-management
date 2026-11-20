import type { Capability } from "../../lib/permissions";

/**
 * One associate either follows the general Permisos («general») or has a
 * complete list of their own («own»), QI-5 step 3. The server keeps the same
 * two answers: no rows, or rows for every switch.
 */
export type PermissionMode = "general" | "own";

/** What a person's switches say, as the screen holds them. */
export interface PersonChoice {
  mode: PermissionMode;
  /** Their own list. Ignored while `mode` is «general». */
  own: ReadonlySet<Capability>;
}

export function sameCapabilities(a: ReadonlySet<Capability>, b: ReadonlySet<Capability>): boolean {
  return a.size === b.size && [...a].every((capability) => b.has(capability));
}

/** What the person would be able to do with this choice. */
export function effectiveCapabilities(
  choice: PersonChoice,
  general: ReadonlySet<Capability>,
): ReadonlySet<Capability> {
  return choice.mode === "own" ? choice.own : general;
}

/**
 * The switches that make this person different from every other associate.
 * Empty while they follow the general list — and also when their own list
 * happens to match it, which the screen then says rather than hides.
 */
export function differencesFromGeneral(
  choice: PersonChoice,
  general: ReadonlySet<Capability>,
  offered: readonly Capability[],
): Capability[] {
  const effective = effectiveCapabilities(choice, general);
  return offered.filter((capability) => effective.has(capability) !== general.has(capability));
}

/**
 * Is there anything to save? Choosing «Permisos propios» counts on its own,
 * even before a switch moves: from then on this person stops following later
 * changes to the general list, and that is a decision worth saving.
 */
export function personChoiceChanged(saved: PersonChoice, current: PersonChoice): boolean {
  if (saved.mode !== current.mode) {
    return true;
  }
  return current.mode === "own" && !sameCapabilities(saved.own, current.own);
}
