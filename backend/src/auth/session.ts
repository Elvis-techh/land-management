import { randomBytes, randomUUID } from "node:crypto";

import { and, eq, gt, lt } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import type { Role } from "../lib/permissions.js";
import { isRole } from "../lib/permissions.js";

export const SESSION_COOKIE = "lindero_session";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

/**
 * Create a login session.
 *
 * The id is 32 random bytes — far too much to guess — and it is the ONLY thing
 * the browser receives. The user's identity and role are never put in the
 * cookie, so there is nothing in it for an attacker to edit in their favour.
 */
export function createSession(db: Db, userId: string, sessionDays: number): string {
  const id = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000).toISOString();

  db.insert(sessions).values({ id, userId, expiresAt }).run();

  return id;
}

/**
 * Look up who a session belongs to, or `null` if it is unknown or expired.
 * Runs on every authenticated request, which is why role changes take effect
 * immediately rather than at the user's next login.
 */
export function getSessionUser(db: Db, sessionId: string): SessionUser | null {
  const now = new Date().toISOString();

  const row = db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, now)))
    .get();

  if (!row || !isRole(row.role)) {
    return null;
  }

  return { id: row.id, name: row.name, email: row.email, role: row.role };
}

export function destroySession(db: Db, sessionId: string): void {
  db.delete(sessions).where(eq(sessions.id, sessionId)).run();
}

/** Housekeeping: drop sessions that have already expired. */
export function deleteExpiredSessions(db: Db): number {
  const result = db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date().toISOString()))
    .run();

  return result.changes;
}

/** Shared id generator, so every table uses the same format. */
export function newId(): string {
  return randomUUID();
}
