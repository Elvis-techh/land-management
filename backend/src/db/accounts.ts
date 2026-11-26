import { and, eq, notInArray } from "drizzle-orm";

import type { AccountsDb } from "./client.js";
import { createAccountsDb } from "./client.js";
import { accountEmails, companies } from "./accountsSchema.js";
import { findMigrationsFolder, runMigrations } from "./migrations.js";

/**
 * The accounts database: which companies exist, and which company each email
 * signs in to. See accountsSchema.ts.
 *
 * Company ids are strings everywhere else in the code ("1", "2"), because they
 * end up in folder names and cookies; here they are the integer key.
 */

/**
 * Open the accounts database, brought up to date, with company 1 in it.
 *
 * Company 1 is the business that used Lindero before there were several. It
 * is added the first time the file is opened, so the real site needs no setup
 * step; its emails are copied in when its own file is opened (see
 * `syncCompanyEmails`).
 */
export function openAccounts(accountsPath: string) {
  const { db, sqlite } = createAccountsDb(accountsPath);

  try {
    runMigrations(db, sqlite, findMigrationsFolder("drizzle-accounts"));
    db.insert(companies).values({ id: 1 }).onConflictDoNothing().run();
  } catch (error) {
    sqlite.close();
    throw error;
  }

  return { db, sqlite };
}

/** Whether a company with this id exists. Never true for an id that is not a number. */
export function companyExists(db: AccountsDb, id: string): boolean {
  const key = Number(id);
  if (!Number.isSafeInteger(key) || String(key) !== id) {
    return false;
  }
  const row = db.select({ id: companies.id }).from(companies).where(eq(companies.id, key)).get();
  return row !== undefined;
}

/** A new company, with the next free id. */
export function createCompany(db: AccountsDb): string {
  const row = db.insert(companies).values({}).returning({ id: companies.id }).get();
  return String(row.id);
}

/** The company this email signs in to, or `null`. */
export function companyForEmail(db: AccountsDb, email: string): string | null {
  const row = db
    .select({ companyId: accountEmails.companyId })
    .from(accountEmails)
    .where(eq(accountEmails.email, email.trim().toLowerCase()))
    .get();
  return row ? String(row.companyId) : null;
}

/** Whether this email already signs in to a company other than this one. */
export function emailUsedElsewhere(db: AccountsDb, email: string, companyId: string): boolean {
  const owner = companyForEmail(db, email);
  return owner !== null && owner !== companyId;
}

/**
 * Make the accounts database list exactly this company's emails.
 *
 * Called after the Usuarios screen adds or changes someone, and whenever a
 * company's file is opened, so a copy that fell behind (a crash between the
 * two writes, a user added with a script) is put right. An email another
 * company already holds is left with that company and returned, to be logged:
 * the Usuarios routes refuse such an email before it is saved, so this only
 * happens if two companies saved the same email at the same moment.
 */
export function syncCompanyEmails(
  db: AccountsDb,
  companyId: string,
  emails: readonly string[],
): { heldElsewhere: string[] } {
  const key = Number(companyId);
  const wanted = [...new Set(emails.map((email) => email.trim().toLowerCase()))];
  const heldElsewhere: string[] = [];

  db.transaction((tx) => {
    tx.delete(accountEmails)
      .where(
        wanted.length > 0
          ? and(eq(accountEmails.companyId, key), notInArray(accountEmails.email, wanted))
          : eq(accountEmails.companyId, key),
      )
      .run();

    for (const email of wanted) {
      tx.insert(accountEmails).values({ email, companyId: key }).onConflictDoNothing().run();

      const owner = tx
        .select({ companyId: accountEmails.companyId })
        .from(accountEmails)
        .where(eq(accountEmails.email, email))
        .get();
      if (owner && owner.companyId !== key) {
        heldElsewhere.push(email);
      }
    }
  });

  return { heldElsewhere };
}
