import { api } from "../../lib/api";
import type { Capability } from "../../lib/permissions";
import type { PermissionMode } from "./permissionChoice";

export interface PermissionRow {
  capability: Capability;
  enabled: boolean;
}

/** An active associate, and whether they have a list of their own. */
export interface AssociateSummary {
  id: string;
  name: string;
  ownPermissions: boolean;
}

export interface PermissionsData {
  /** The role being configured. Only the associate role is editable. */
  role: string;
  capabilities: PermissionRow[];
  /** Capabilities that can never be handed over, whatever the supervisor wants. */
  locked: Capability[];
  /** Every active associate. Older servers don't send it. */
  associates?: AssociateSummary[];
}

export function fetchPermissions() {
  return api.get<PermissionsData>("/api/permissions");
}

/** Sends the COMPLETE set of granted capabilities, not a delta. */
export function savePermissions(capabilities: Capability[]) {
  return api.put<{ role: string; capabilities: Capability[] }>("/api/permissions", {
    capabilities,
  });
}

/** One associate's permissions, with what the general list says beside each. */
export interface PersonPermissionsData {
  user: { id: string; name: string };
  mode: PermissionMode;
  capabilities: Array<PermissionRow & { general: boolean }>;
  locked: Capability[];
}

export function fetchPersonPermissions(userId: string) {
  return api.get<PersonPermissionsData>(`/api/permissions/users/${encodeURIComponent(userId)}`);
}

/** Back to the general list, or a COMPLETE list of their own. */
export function savePersonPermissions(
  userId: string,
  body: { mode: "general" } | { mode: "own"; capabilities: Capability[] },
) {
  return api.put<{ mode: PermissionMode; capabilities: Capability[] }>(
    `/api/permissions/users/${encodeURIComponent(userId)}`,
    body,
  );
}
