import { randomUUID } from "node:crypto";

import type { Db } from "../db/client.js";
import { auditEvents } from "../db/schema.js";

/**
 * Accepts either the database handle or a transaction handle, so audit rows can
 * be written inside the same transaction as the change they describe.
 */
type AuditWriter = Pick<Db, "insert">;

/**
 * What the Historial keeps, and what it deliberately does not.
 *
 * This is a small office app on a disk it shares with another business, not a
 * compliance system, and an audit row is never deleted. So it records the
 * moments somebody changed, took back or destroyed something that was already
 * on file — an edit, a reprice, an archive, a restore, a delete, a void, a
 * cancellation, a removed file — and nothing else. Left out on purpose:
 *
 *  - Creating a lot, a contract, a project, a customer or a receipt. The row
 *    itself is the record, and a later edit's `before` says what it used to be.
 *    A void is the one exception: it takes the whole receipt back, so that row
 *    restates the receipt in full. (A new user account is still filed — who was
 *    given access to the system is worth knowing.)
 *  - Sign-ins. A permanent row per sign-in that said only "somebody opened
 *    the app"; `users.last_sign_in_at` keeps the one fact anybody read.
 *  - A contract settling or reopening, which only ever follows a payment that
 *    is already in the history.
 *  - Receipt notes, and a file being attached. Only removing one is recorded.
 *
 * Before adding a call to `recordAudit`, ask whether somebody will ever need to
 * know who did it and what it replaced. If the answer is "it was added", it is
 * not worth a row.
 */
export interface AuditEntry {
  actorId: string;
  entityType:
    | "lot"
    | "project"
    | "customer"
    | "contract"
    | "payment"
    | "user"
    | "role"
    | "exchange_rate";
  entityId: string;
  action:
    | "create"
    | "update"
    | "reprice"
    | "archive"
    | "restore"
    | "delete"
    | "cancel"
    /** A contract's lot was corrected — a data-entry mistake, not a new sale. */
    | "reassign_lot"
    /** A contract the owner declared uncollectable — the customer defaulted. */
    | "default"
    /** A contract closed by an adenda and succeeded by a new one on the same lot. */
    | "replace"
    | "reverse";
  reason?: string | null;
  before?: unknown;
  after?: unknown;
}

/**
 * Append one row to the audit history.
 *
 * Call this inside the same transaction as the change it describes. If the
 * change rolls back, its audit row must roll back with it — an audit log that
 * records things that did not happen is worse than none at all.
 */
export function recordAudit(db: AuditWriter, entry: AuditEntry): void {
  db.insert(auditEvents)
    .values({
      id: randomUUID(),
      actorId: entry.actorId,
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      reason: entry.reason ?? null,
      beforeJson: entry.before === undefined ? null : JSON.stringify(entry.before),
      afterJson: entry.after === undefined ? null : JSON.stringify(entry.after),
    })
    .run();
}
