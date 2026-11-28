import { join } from "node:path";
import { deleteExpiredSessions } from "../auth/session.js";
import { createDb } from "./client.js";
import { runMigrations } from "./migrations.js";
/** Today's Lindero: one company, so every request gets the same one. */
export function singleCompany(company) {
    return {
        forRequest: () => company,
        open: () => [company],
    };
}
export const FIRST_COMPANY = "1";
const COMPANY_ID = /^[1-9][0-9]{0,9}$/;
/**
 * Where a company's files are.
 *
 * Company 1 keeps the files it has always had (`DATABASE_PATH` and
 * `UPLOADS_PATH`), so the real site, its backups and its restore steps stay as
 * they are. Every other company gets a folder of its own under
 * `COMPANIES_PATH`: `<id>/lindero.db` and `<id>/uploads/`. The nightly backup
 * (scripts/backup.mjs) reads the same layout.
 */
export function companyFiles(config, id) {
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
export function openCompany(id, files) {
    const { db, sqlite } = createDb(files.databasePath);
    try {
        runMigrations(db, sqlite);
    }
    catch (error) {
        sqlite.close();
        throw error;
    }
    const expiredSessions = deleteExpiredSessions(db);
    return { company: { id, db, sqlite, uploadsPath: files.uploadsPath }, expiredSessions };
}
//# sourceMappingURL=companies.js.map