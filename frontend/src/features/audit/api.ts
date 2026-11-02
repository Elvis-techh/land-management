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
  | "reassign_lot"
  | "replace"
  | "reverse"
  | "mora_charge"
  | "mora_remove"
  | "mora_forgive"
  | "mora_unforgive"
  | "mora_rule"
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

/** What the history can be narrowed by (#6). Empty lists mean "all". */
export interface AuditFilters {
  actorIds: string[];
  entityTypes: string[];
  /** Business dates, "YYYY-MM-DD", both ends included. Empty for no bound. */
  from: string;
  to: string;
}

export const NO_AUDIT_FILTERS: AuditFilters = { actorIds: [], entityTypes: [], from: "", to: "" };

export interface AuditQuery {
  limit?: number;
  offset?: number;
  search?: string;
  filters?: AuditFilters;
  order?: "desc" | "asc";
}

/** The query string the server reads. Search and filters run there: see routes/audit.ts. */
export function auditParams(options: AuditQuery = {}): URLSearchParams {
  const params = new URLSearchParams({
    limit: String(options.limit ?? 50),
    offset: String(options.offset ?? 0),
  });
  const filters = options.filters ?? NO_AUDIT_FILTERS;
  const search = (options.search ?? "").trim();

  if (search !== "") {
    params.set("q", search);
  }
  if (filters.actorIds.length > 0) {
    params.set("actorIds", filters.actorIds.join(","));
  }
  if (filters.entityTypes.length > 0) {
    params.set("entityTypes", filters.entityTypes.join(","));
  }
  if (filters.from !== "") {
    params.set("from", filters.from);
  }
  if (filters.to !== "") {
    params.set("to", filters.to);
  }
  if (options.order === "asc") {
    params.set("order", "asc");
  }

  return params;
}

export function fetchAudit(options: AuditQuery = {}) {
  return api.get<AuditPage>(`/api/audit?${auditParams(options).toString()}`);
}

export interface AuditActor {
  id: string;
  name: string;
}

/** Everybody who has made a change, for the «Quién» filter. */
export function fetchAuditActors() {
  return api.get<{ actors: AuditActor[] }>("/api/audit/actors");
}
