import { join } from "node:path";

import type { FastifyRequest } from "fastify";

import { SESSION_COOKIE, deleteExpiredSessions, readSessionCookie } from "../auth/session.js";
import type { AppConfig } from "../config/env.js";
import {
  companyExists,
  companyForEmail,
  emailUsedElsewhere,
  syncCompanyEmails,
} from "./accounts.js";
import type { AccountsDb, Db } from "./client.js";
import { createDb } from "./client.js";
import { runMigrations } from "./migrations.js";
import { users } from "./schema.js";

/**
 * One company's Lindero: its database file and its uploads folder.
 *
 * Lindero is moving to one database file per company (docs/later-versions.md,
 * section 1). A company's records, uploaded files, live updates and list
 * versions never mix with another's; everything that used to belong to "the
 * app" now belongs to one of these.
 */
export interface Company {
  /**
   * "1" is the business that used Lindero before there were several. Digits
   * only, because it becomes part of a folder name.
   */
  id: string;
  db: Db;
  /** The open file under `db`, to close it. */
  sqlite: ReturnType<typeof createDb>["sqlite"];
  uploadsPath: string;
}

/**
 * Which company a request works on, and which companies are open.
 *
 * The real app uses `companyRegistry`: the company named by the session
 * cookie, its file opened when first needed. Tests that need one company use
 * `singleCompany`.
 */
export interface Companies {
  /** The company this request reads and writes. */
  forRequest(request: FastifyRequest): Company;
  /** Every company whose file is open now, for the jobs that run on a timer. */
  open(): Company[];
  /** The company this email signs in to, opened, or `null` if none has it. */
  forEmail(email: string): Company | null;
  /** Whether a company other than this one already signs this email in. */
  emailUsedElsewhere(company: Company, email: string): boolean;
  /** A company's users changed: copy its emails to the accounts database. */
  usersChanged(company: Company): void;
}

/** One company, and nothing else: every request and every email gets it. */
export function singleCompany(company: Company): Companies {
  return {
    forRequest: () => company,
    open: () => [company],
    forEmail: () => company,
    emailUsedElsewhere: () => false,
    usersChanged: () => undefined,
  };
}

export const FIRST_COMPANY = "1";

/** Digits only: an id becomes part of a folder name and of the session cookie. */
export const COMPANY_ID = /^[1-9][0-9]{0,9}$/;

/**
 * Where a company's files are.
 *
 * Company 1 keeps the files it has always had (`DATABASE_PATH` and
 * `UPLOADS_PATH`), so the real site, its backups and its restore steps stay as
 * they are. Every other company gets a folder of its own under
 * `COMPANIES_PATH`: `<id>/lindero.db` and `<id>/uploads/`. The nightly backup
 * (scripts/backup.mjs) reads the same layout.
 */
export function companyFiles(
  config: Pick<AppConfig, "databasePath" | "uploadsPath" | "companiesPath">,
  id: string,
): { databasePath: string; uploadsPath: string } {
  // The id becomes part of a path: nothing but digits may reach `join`.
  if (!COMPANY_ID.test(id)) {
    throw new Error(`Not a company id: ${JSON.stringify(id)}`);
  }

  if (id === FIRST_COMPANY) {
    return { databasePath: config.databasePath, uploadsPath: config.uploadsPath };
  }

  const folder = join(config.companiesPath, id);
  return { databasePath: join(folder, "lindero.db"), uploadsPath: join(folder, "uploads") };
}

/**
 * Open a company's database, ready to serve.
 *
 * The schema is brought up to date here, on opening, rather than once for the
 * whole server at startup: a company whose file is opened later, or created
 * by a signup, gets the same upgrades as the ones open at boot. A failed
 * migration throws, and that company is not served on a half-built schema.
 * Expired sessions are swept at the same moment; the count is for the log.
 */
export function openCompany(
  id: string,
  files: { databasePath: string; uploadsPath: string },
): { company: Company; expiredSessions: number } {
  const { db, sqlite } = createDb(files.databasePath);

  try {
    runMigrations(db, sqlite);
  } catch (error) {
    sqlite.close();
    throw error;
  }

  const expiredSessions = deleteExpiredSessions(db);

  return { company: { id, db, sqlite, uploadsPath: files.uploadsPath }, expiredSessions };
}

/** How long a company's file stays open with nobody using it. */
export const IDLE_CLOSE_MS = 15 * 60 * 1000;

interface Notices {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
}

/**
 * Every company, each opened the first time it is needed.
 *
 * A request belongs to the company its session cookie names (see
 * `readSessionCookie` in auth/session.ts); one without a cookie, or with one
 * naming no company, gets company 1, where it finds no session. Nothing but
 * signing in, signing out and the health check answers without a session, and
 * signing in finds its company from the email (`forEmail`), so an anonymous
 * request reads nobody's records.
 *
 * Only a company listed in the accounts database is opened: an id typed into
 * a cookie can never create a file. Opening a company upgrades its schema and
 * puts its emails right in the accounts database.
 *
 * A company nobody has used for `idleMs` is closed by `closeIdle`, which the
 * server runs on a timer, so memory follows the companies in use rather than
 * every company there is. Company 1 stays open. A request is far shorter than
 * `idleMs`, and the live stream stops using the database once it has started,
 * so a file is never closed under a request that still needs it.
 */
export function companyRegistry(
  config: Pick<AppConfig, "databasePath" | "uploadsPath" | "companiesPath">,
  accounts: AccountsDb,
  options: {
    log?: Notices;
    idleMs?: number;
    now?: () => number;
    /** Runs once each time a company other than 1 is opened. */
    onOpen?: (company: Company) => void;
  } = {},
) {
  const idleMs = options.idleMs ?? IDLE_CLOSE_MS;
  const now = options.now ?? Date.now;
  const opened = new Map<string, { company: Company; lastUsed: number }>();

  const syncEmails = (company: Company) => {
    const emails = company.db.select({ email: users.email }).from(users).all();
    const { heldElsewhere } = syncCompanyEmails(
      accounts,
      company.id,
      emails.map((row) => row.email),
    );
    if (heldElsewhere.length > 0) {
      options.log?.warn(
        { companyId: company.id, emails: heldElsewhere },
        "Emails already used by another company; they still sign in there",
      );
    }
  };

  /** The company with this id, opened if it is not yet; `null` if there is none. */
  const get = (id: string): Company | null => {
    const entry = opened.get(id);
    if (entry) {
      entry.lastUsed = now();
      return entry.company;
    }

    if (!COMPANY_ID.test(id) || !companyExists(accounts, id)) {
      return null;
    }

    const { company, expiredSessions } = openCompany(id, companyFiles(config, id));
    opened.set(id, { company, lastUsed: now() });
    if (expiredSessions > 0) {
      options.log?.info({ companyId: id, removed: expiredSessions }, "Deleted expired sessions");
    }
    syncEmails(company);
    if (id !== FIRST_COMPANY) {
      options.onOpen?.(company);
    }
    return company;
  };

  const first = () => {
    const company = get(FIRST_COMPANY);
    if (!company) {
      throw new Error("The accounts database has no company 1");
    }
    return company;
  };

  return {
    get,

    forRequest(request: FastifyRequest): Company {
      const cookie = readSessionCookie(request.cookies[SESSION_COOKIE]);
      return (cookie && get(cookie.companyId)) || first();
    },

    open: () => [...opened.values()].map((entry) => entry.company),

    forEmail(email: string): Company | null {
      const id = companyForEmail(accounts, email);
      return id === null ? null : get(id);
    },

    emailUsedElsewhere: (company: Company, email: string) =>
      emailUsedElsewhere(accounts, email, company.id),

    usersChanged: syncEmails,

    /** Close every company unused for `idleMs`, except company 1. Returns their ids. */
    closeIdle(): string[] {
      const closed: string[] = [];
      for (const [id, entry] of opened) {
        if (id !== FIRST_COMPANY && now() - entry.lastUsed >= idleMs) {
          entry.company.sqlite.close();
          opened.delete(id);
          closed.push(id);
        }
      }
      return closed;
    },

    /** Close every open file, for shutdown. */
    closeAll(): void {
      for (const entry of opened.values()) {
        entry.company.sqlite.close();
      }
      opened.clear();
    },
  } satisfies Companies & Record<string, unknown>;
}
