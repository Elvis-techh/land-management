import { eq } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { roleCapabilities, userCapabilities } from "../db/schema.js";
import type { Capability, Role } from "./permissions.js";
import {
  CAPABILITIES,
  DEFAULT_CAPABILITIES_BY_ROLE,
  LOCKED_CAPABILITIES,
  isCapability,
} from "./permissions.js";

/**
 * What a role can actually do right now, after the supervisor's edits.
 *
 * Read fresh from the database on every check rather than cached. A permission
 * change has to take effect for a signed-in associate immediately — a cache
 * would mean a revoked permission still working until something expired, which
 * is precisely the moment it matters. This is one indexed SQLite read, in
 * process, so the cost is not worth the risk.
 */
export function resolveCapabilities(db: Db, role: Role): ReadonlySet<Capability> {
  // The owner is not configurable and is not read from the table. There has to
  // be one account that cannot be locked out of its own app.
  if (role === "owner") {
    return new Set<Capability>(CAPABILITIES);
  }

  const rows = db
    .select({ capability: roleCapabilities.capability, enabled: roleCapabilities.enabled })
    .from(roleCapabilities)
    .where(eq(roleCapabilities.role, role))
    .all();

  // No rows at all means nobody has ever configured this role — a freshly
  // migrated database. Fall back to the defaults instead of leaving the
  // associate unable to do anything. A supervisor who has switched everything
  // off is NOT this case: those rows exist, they just all say `false`.
  if (rows.length === 0) {
    return DEFAULT_CAPABILITIES_BY_ROLE[role];
  }

  const granted = new Set<Capability>();

  for (const row of rows) {
    // A capability that was removed from the code, or one that is locked, is
    // ignored even if a row for it somehow exists. A capability ADDED to the
    // code since this role was configured has no row, and so stays off until
    // the supervisor grants it — the safe direction for a new power.
    if (row.enabled && isCapability(row.capability) && !LOCKED_CAPABILITIES.has(row.capability)) {
      granted.add(row.capability);
    }
  }

  return granted;
}

/** Does this role currently have this capability? */
export function roleCan(db: Db, role: Role, capability: Capability): boolean {
  return resolveCapabilities(db, role).has(capability);
}

/** Who is asking: enough of a signed-in user to work out what they may do. */
export interface CapabilityHolder {
  id: string;
  role: Role;
}

/**
 * One associate's own list, or `null` while they follow the general one.
 *
 * Rows exist only once the supervisor has chosen «Permisos propios» for this
 * person, and they are the complete list, OFF switches included. A capability
 * that is locked, or that the code no longer knows, is ignored even if a row
 * for it somehow exists; one ADDED to the code since has no row and stays off,
 * the safe direction for a new power — the same rules as the role's rows.
 */
export function ownCapabilities(db: Db, userId: string): ReadonlySet<Capability> | null {
  const rows = db
    .select({ capability: userCapabilities.capability, enabled: userCapabilities.enabled })
    .from(userCapabilities)
    .where(eq(userCapabilities.userId, userId))
    .all();

  if (rows.length === 0) {
    return null;
  }

  const granted = new Set<Capability>();

  for (const row of rows) {
    if (row.enabled && isCapability(row.capability) && !LOCKED_CAPABILITIES.has(row.capability)) {
      granted.add(row.capability);
    }
  }

  return granted;
}

/**
 * What this PERSON can do right now: the supervisor everything, an associate
 * their own list when they have one, and the general list otherwise.
 *
 * Every route guard asks this, not `resolveCapabilities`, so a permission given
 * to or taken from one associate works on that person's very next request.
 * Read fresh each time, for the same reason as the role's list.
 */
export function resolveUserCapabilities(db: Db, user: CapabilityHolder): ReadonlySet<Capability> {
  if (user.role === "owner") {
    return new Set<Capability>(CAPABILITIES);
  }

  return ownCapabilities(db, user.id) ?? resolveCapabilities(db, user.role);
}

/** Can this person do this, right now? */
export function userCan(db: Db, user: CapabilityHolder, capability: Capability): boolean {
  return resolveUserCapabilities(db, user).has(capability);
}
