/**
 * Who is allowed to do what.
 *
 * Two design rules make this cheap to grow later:
 *
 * 1. Code asks about a CAPABILITY, never about a role. Write
 *    `can(user, "lot:archive")`, never `user.role === "owner"`. Adding a third
 *    role later then means editing this one file, instead of hunting for every
 *    place a role name was hard-coded.
 *
 * 2. This file is a convenience for the UI only. It decides which buttons to
 *    show. It is NOT security — anyone can edit JavaScript in their browser.
 *    The same capability check must run on the server for every write, and the
 *    server's answer is the only one that counts.
 */

export type Role = "owner" | "staff";

export type Capability =
  | "lot:create"
  | "lot:edit"
  | "lot:archive"
  | "project:create"
  | "project:edit"
  | "project:archive"
  | "customer:create"
  | "customer:edit"
  | "contract:create"
  | "contract:cancel"
  | "payment:record"
  | "payment:reverse"
  | "price:change"
  | "rate:edit"
  | "audit:view"
  | "permission:manage"
  | "user:manage";

/**
 * `staff` can record the day-to-day work: new customers, new contracts, taking
 * payments. What they cannot do is change history or destroy records — edit a
 * lot, change a price, cancel a contract, reverse a payment, or manage users.
 *
 * That split is not bureaucracy. It is the exact thing a landowner wants when
 * handing the app to an employee.
 */
/**
 * The starting point, before any supervisor edits — and the fallback when the
 * server has not told us otherwise.
 */
const DEFAULT_CAPABILITIES_BY_ROLE: Record<Role, ReadonlySet<Capability>> = {
  owner: new Set<Capability>([
    "lot:create",
    "lot:edit",
    "lot:archive",
    "project:create",
    "project:edit",
    "project:archive",
    "customer:create",
    "customer:edit",
    "contract:create",
    "contract:cancel",
    "payment:record",
    "payment:reverse",
    "price:change",
    "rate:edit",
    "audit:view",
    "permission:manage",
    "user:manage",
  ]),
  staff: new Set<Capability>([
    "lot:create",
    "customer:create",
    "customer:edit",
    "contract:create",
    "payment:record",
  ]),
};

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  /**
   * What this user may actually do, as the server computed it.
   *
   * The supervisor can change what the associate role is allowed to do, so this
   * is no longer a property of the role name — it arrives with the session and
   * is re-read on every page load. `undefined` means an older response that did
   * not carry it; the built-in defaults stand in.
   */
  capabilities?: Capability[];
}

/**
 * Should this user see this button?
 *
 * Convenience only. The server re-checks the same capability on every write and
 * its answer is the one that counts — which is what makes it safe for this list
 * to be a little out of date when a supervisor changes the rules mid-session.
 */
export function can(user: User, capability: Capability): boolean {
  if (user.capabilities) {
    return user.capabilities.includes(capability);
  }

  return DEFAULT_CAPABILITIES_BY_ROLE[user.role].has(capability);
}

/** What each role is called in the interface. */
export const ROLE_LABELS: Record<Role, string> = {
  owner: "Supervisor",
  staff: "Asociado",
};

/**
 * Actions that require the user to type WHY before they are allowed through.
 *
 * Deliberately short. Asking for a justification on every edit trains people to
 * type "x" and move on, which destroys the value of asking at all. Ask only
 * where the answer will actually matter to somebody reading it back later.
 */
export const REQUIRES_REASON: ReadonlySet<Capability> = new Set<Capability>([
  "lot:archive",
  "contract:cancel",
  "payment:reverse",
  "price:change",
]);
