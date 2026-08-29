import { randomUUID } from "node:crypto";

import type { Db } from "../db/client.js";
import { auditEvents } from "../db/schema.js";

/**
 * Accepts either the database handle or a transaction handle, so audit rows can
 * be written inside the same transaction as the change they describe.
 */
type AuditWriter = Pick<Db, "insert">;

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
    | "reverse"
    | "login"
    | "logout";
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
