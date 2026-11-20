import { capabilityLabel } from "../permissions/capabilityGroups";

/**
 * A permissions change as a person reads it: «Ahora puede: Archivar lotes» and
 * «Ya no puede: Crear lotes», in the words of the Permisos screen.
 *
 * The server files the whole list before and after (the question later is
 * "could this associate do that on that day?"), and shown side by side two
 * lists of ten codes hide the one that changed. `null` when either side isn't
 * a list, so the row falls back to showing what is there.
 */
export function capabilityChanges(
  before: unknown,
  after: unknown,
): { added: string[]; removed: string[] } | null {
  if (!Array.isArray(before) || !Array.isArray(after)) {
    return null;
  }

  const had = new Set(before.map(String));
  const has = new Set(after.map(String));

  return {
    added: [...has].filter((capability) => !had.has(capability)).map(capabilityLabel),
    removed: [...had].filter((capability) => !has.has(capability)).map(capabilityLabel),
  };
}
