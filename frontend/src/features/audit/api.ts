import { api } from "../../lib/api";
import type { Role } from "../../lib/permissions";

export type AuditAction =
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

export interface AuditEvent {
  id: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  /** Human label for the thing that changed, e.g. a lot code. */
  entityLabel: string | null;
  actorName: string;
  actorRole: Role;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
}

export interface AuditPage {
  events: AuditEvent[];
  total: number;
  limit: number;
  offset: number;
}

export function fetchAudit(options: { limit?: number; offset?: number } = {}) {
  const params = new URLSearchParams({
    limit: String(options.limit ?? 50),
    offset: String(options.offset ?? 0),
  });

  return api.get<AuditPage>(`/api/audit?${params.toString()}`);
}
