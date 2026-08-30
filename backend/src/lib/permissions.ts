/**
 * Who is allowed to do what — the server's copy, and the one that counts.
 *
 * The frontend has a matching file so it can hide buttons, but that is only a
 * convenience for the user. Anyone can edit JavaScript in their browser, so
 * every write route re-checks the capability here before touching the database.
 *
 * Code asks about a CAPABILITY, never about a role. Adding a third role later
 * means editing this table and nothing else.
 *
 * The lists below are DEFAULTS. Since the supervisor can now edit what the
 * associate role may do, the live answer comes from `resolveCapabilities` in
 * src/lib/capabilities.ts, which reads the `role_capabilities` table and falls
 * back to these defaults when it has never been configured.
 */

export const ROLES = ["owner", "staff"] as const;
export type Role = (typeof ROLES)[number];

export const CAPABILITIES = [
  "lot:create",
  "lot:edit",
  "lot:archive",
  "project:create",
  "project:edit",
  "project:archive",
  "customer:create",
  "customer:edit",
  "customer:delete",
  "contract:create",
  "contract:edit",
  "contract:reprice",
  "contract:cancel",
  "payment:record",
  "payment:reverse",
  "price:change",
  "rate:edit",
  "audit:view",
  "permission:manage",
  "user:manage",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * Capabilities that can NEVER be granted to another role, whatever the
 * supervisor toggles.
 *
 * This is the lock that makes editable permissions safe. Without it, a
 * supervisor could hand `permission:manage` to the associate role, and an
 * associate could then grant themselves everything — including `user:manage`,
 * which is the only way back. Account control stays with the owner by
 * construction, not by anybody remembering not to tick a box.
 */
export const LOCKED_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "permission:manage",
  "user:manage",
]);

/** The capabilities a supervisor is allowed to turn on and off for a role. */
export const EDITABLE_CAPABILITIES: readonly Capability[] = CAPABILITIES.filter(
  (capability) => !LOCKED_CAPABILITIES.has(capability),
);

/**
 * `staff` starts able to record the day-to-day work: new customers, new
 * contracts, taking payments. What they cannot do out of the box is change
 * history or destroy records — edit a lot, change a price, cancel a contract,
 * reverse a payment, or manage users.
 *
 * That split is not bureaucracy. It is the exact thing a landowner wants when
 * handing the app to an employee — and it is now a starting point rather than a
 * verdict, since the supervisor can adjust it.
 */
export const DEFAULT_CAPABILITIES_BY_ROLE: Record<Role, ReadonlySet<Capability>> = {
  owner: new Set<Capability>(CAPABILITIES),
  staff: new Set<Capability>([
    "lot:create",
    "customer:create",
    "customer:edit",
    "contract:create",
    "payment:record",
  ]),
};

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

/**
 * The DEFAULT answer, before any supervisor edits.
 *
 * Route guards must not call this — they need `resolveCapabilities`, which
 * knows what the supervisor has configured. It stays exported because the
 * defaults are what an unconfigured database falls back to.
 */
export function can(role: Role, capability: Capability): boolean {
  return DEFAULT_CAPABILITIES_BY_ROLE[role].has(capability);
}
