import { api } from "../../lib/api";
import type { Capability } from "../../lib/permissions";

export interface PermissionRow {
  capability: Capability;
  enabled: boolean;
}

export interface PermissionsData {
  /** The role being configured. Only the associate role is editable. */
  role: string;
  capabilities: PermissionRow[];
  /** Capabilities that can never be handed over, whatever the supervisor wants. */
  locked: Capability[];
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
