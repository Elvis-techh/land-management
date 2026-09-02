import { api } from "../../lib/api";
import type { Role } from "../../lib/permissions";

/**
 * One account that can sign in.
 *
 * There is no password field here and there never will be: the server stores a
 * scrypt hash and sends nothing about it, so the interface has nothing to leak.
 */
export interface UserAccount {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** When the account was switched off, or `null` while it can still sign in. */
  deactivatedAt: string | null;
  createdAt: string;
  /**
   * Read out of the audit log's login events rather than from a stored column,
   * so it cannot disagree with the history beside it. `null` means this account
   * has never signed in — which is exactly what a new hire looks like.
   */
  lastSignInAt: string | null;
  /** Whether this is the signed-in supervisor's own account. */
  isSelf: boolean;
}

interface UsersResponse {
  users: UserAccount[];
}

export function fetchUsers(): Promise<UserAccount[]> {
  return api.get<UsersResponse>("/api/users").then((response) => response.users);
}

/** What the form sends when creating. The password travels once and is never read back. */
export interface UserDraft {
  name: string;
  email: string;
  role: Role;
}

export function createUser(draft: UserDraft & { password: string }) {
  return api.post<{ user: UserAccount }>("/api/users", draft);
}

/** Editing an account never touches its password — that has its own dialog. */
export function updateUser(userId: string, draft: UserDraft) {
  return api.patch<{ user: UserAccount }>(`/api/users/${userId}`, draft);
}

/**
 * Replace somebody's password.
 *
 * Every session that account has open ends with it, which is the point: a
 * password reset because it leaked is worth nothing while the session opened
 * with the old one still works.
 */
export function resetUserPassword(userId: string, password: string) {
  return api.put<{ ok: true; endedSessions: number }>(`/api/users/${userId}/password`, {
    password,
  });
}

/**
 * Switch an account off. Not a delete — there is no delete.
 *
 * This person's id is written on every payment they recorded and every line of
 * the history, and removing it would take the answer to "who received this
 * money" with it.
 */
export function deactivateUser(userId: string) {
  return api.post<{ ok: true; deactivatedAt: string }>(`/api/users/${userId}/deactivate`);
}

export function reactivateUser(userId: string) {
  return api.post<{ ok: true }>(`/api/users/${userId}/reactivate`);
}
