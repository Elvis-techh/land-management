import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { auditEvents, contracts, customers, lots, projects, users } from "../db/schema.js";
import { businessDayStartUtc } from "../lib/time.js";
const ENTITY_TYPES = [
    "lot",
    "project",
    "customer",
    "contract",
    "payment",
    "user",
    "role",
    "exchange_rate",
    "settings",
];
/** "a,b,c" into a list, each checked against `allowed`. */
const commaList = (allowed) => z
    .string()
    .max(2000)
    .transform((value) => value.split(",").map((entry) => entry.trim()).filter((entry) => entry !== ""))
    .pipe(z.array(allowed).max(50));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const auditQuery = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    /**
     * Optional filter, e.g. only lot changes. Every value `recordAudit` can
     * write is listed here — `project`, `role` and `exchange_rate` were missing,
     * so events that are recorded could never be filtered for.
     */
    entityType: z.enum(ENTITY_TYPES).optional(),
    /*
     * #6: the Historial screen's search, filters and sort. They are applied here
     * because the history is read a page at a time: filtering the 25 rows on
     * screen would miss every match on the other pages.
     */
    /** Several kinds at once, e.g. "contract,payment". */
    entityTypes: commaList(z.enum(ENTITY_TYPES)).optional(),
    /** Who made the change, by user id. */
    actorIds: commaList(z.string().min(1).max(100)).optional(),
    /** Business dates, both ends included. */
    from: isoDate.optional(),
    to: isoDate.optional(),
    /** Customer, lot, contract, project, receipt… every word has to match. */
    q: z.string().max(100).optional(),
    order: z.enum(["desc", "asc"]).default("desc"),
});
/**
 * Stored timestamps come in two shapes ("2026-08-28T01:23:45.678Z" from the
 * app, "2026-08-28 01:23:45" from SQLite's default; see lib/time.ts). This
 * puts both in the second, which sorts and compares correctly as text.
 */
const createdAtUtc = sql `replace(replace(${auditEvents.createdAt}, 'T', ' '), 'Z', '')`;
/** The day after "YYYY-MM-DD", for an end date that includes its whole day. */
function nextDay(date) {
    const next = new Date(`${date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString().slice(0, 10);
}
/** Escapes LIKE's own wildcards, so a typed "%" or "_" means itself. */
function likePattern(word) {
    return `%${word.toLowerCase().replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}
/**
 * The name a row carries in its own snapshot, when nothing is left to join to.
 *
 * Deleting a customer leaves the joins below with nothing to find: the row they
 * would have named no longer exists. The delete event stores the whole record
 * in `before` precisely so the history can still say who it was, and this reads
 * it back. Without it, the last thing the log ever says about a person is a
 * UUID.
 *
 * Receipts are not joined, so the rows that are about one — a void, a removed
 * file — carry its code in their snapshot for the same reason.
 */
function snapshotLabel(snapshot) {
    const name = snapshot?.fullName ?? snapshot?.name ?? snapshot?.code ?? snapshot?.receiptCode;
    return typeof name === "string" ? name : null;
}
/**
 * What a settings row is about. Its id is the section, not a UUID, so there is
 * nothing to join to; and without this the business section would be labelled
 * with the business's own name from its snapshot.
 */
const SETTINGS_LABELS = {
    mora: "Mora",
    contracts: "Contratos",
    business: "Datos del negocio",
};
/**
 * Read the total two ways and they disagree the moment a filter is applied:
 * the page of rows was filtered, the count was not, and the Historial screen
 * then offered pages of events that were not there. One `where` clause, built
 * once, drives both queries.
 */
function auditWhere(filters, timeZone, subjectName) {
    const conditions = [];
    const types = [...(filters.entityTypes ?? []), ...(filters.entityType ? [filters.entityType] : [])];
    if (types.length > 0) {
        conditions.push(inArray(auditEvents.entityType, types));
    }
    if (filters.actorIds && filters.actorIds.length > 0) {
        conditions.push(inArray(auditEvents.actorId, filters.actorIds));
    }
    if (filters.from) {
        conditions.push(sql `${createdAtUtc} >= ${businessDayStartUtc(filters.from, timeZone)}`);
    }
    if (filters.to) {
        conditions.push(sql `${createdAtUtc} < ${businessDayStartUtc(nextDay(filters.to), timeZone)}`);
    }
    // Everything a row can be found by: what it is about, and what its snapshots
    // say (a receipt's customer, a payment's lot), so "Elena" finds her payments.
    const haystack = sql `lower(
    coalesce(${lots.code}, '') || ' ' || coalesce(${customers.fullName}, '') || ' ' ||
    coalesce(${projects.name}, '') || ' ' || coalesce(${contracts.code}, '') || ' ' ||
    coalesce(${subjectName}, '') || ' ' || coalesce(${auditEvents.reason}, '') || ' ' ||
    coalesce(${auditEvents.beforeJson}, '') || ' ' || coalesce(${auditEvents.afterJson}, '')
  )`;
    for (const word of (filters.q ?? "").trim().split(/\s+/).filter((entry) => entry !== "")) {
        conditions.push(sql `${haystack} LIKE ${likePattern(word)} ESCAPE '\\'`);
    }
    return conditions.length > 0 ? and(...conditions) : undefined;
}
/**
 * The change history.
 *
 * Read-only by design: there is no endpoint to edit or delete an audit row.
 * A history someone can rewrite is not a history.
 */
export const auditRoutes = async (app, options) => {
    /**
     * Everybody who has made a change, for the «Quién» filter. Read from the
     * history itself, so a deactivated account that made changes is still there.
     */
    app.get("/audit/actors", { onRequest: app.requireCapability("audit:view") }, async (_request, reply) => {
        const actors = app.db
            .selectDistinct({ id: users.id, name: users.name })
            .from(auditEvents)
            .innerJoin(users, eq(users.id, auditEvents.actorId))
            .orderBy(users.name)
            .all();
        return reply.send({ actors });
    });
    app.get("/audit", { onRequest: app.requireCapability("audit:view") }, async (request, reply) => {
        const parsed = auditQuery.safeParse(request.query);
        if (!parsed.success) {
            return reply.code(400).send({ error: "invalid_query", message: "Parámetros inválidos." });
        }
        const { limit, offset, order } = parsed.data;
        // Resolve a human-readable label for whatever the row points at, so the
        // screen shows "A-07" rather than a UUID.
        const actor = users;
        // A second, ALIASED reference to the same table: an audit row about a user
        // account has an actor and a subject, and both are users. Without the alias
        // SQLite sees one table joined to itself under one name and the row names
        // the person who made the change rather than the account that changed.
        const subject = alias(users, "subject_user");
        const where = auditWhere(parsed.data, options.timeZone, sql `${subject.name}`);
        const rows = app.db
            .select({
            id: auditEvents.id,
            action: auditEvents.action,
            entityType: auditEvents.entityType,
            entityId: auditEvents.entityId,
            reason: auditEvents.reason,
            beforeJson: auditEvents.beforeJson,
            afterJson: auditEvents.afterJson,
            createdAt: auditEvents.createdAt,
            actorName: actor.name,
            actorRole: actor.role,
            lotCode: lots.code,
            customerName: customers.fullName,
            projectName: projects.name,
            contractCode: contracts.code,
            subjectName: subject.name,
        })
            .from(auditEvents)
            .innerJoin(actor, eq(actor.id, auditEvents.actorId))
            // One join per kind of entity a row can point at. Entity ids are UUIDs,
            // so at most one of these ever matches, and the rest come back null.
            .leftJoin(lots, eq(lots.id, auditEvents.entityId))
            .leftJoin(customers, eq(customers.id, auditEvents.entityId))
            .leftJoin(projects, eq(projects.id, auditEvents.entityId))
            // A contract is never deleted, so this always finds it. Without it, an
            // edit, a cancel or a lot correction said WHAT changed and not which
            // contract it was about.
            .leftJoin(contracts, eq(contracts.id, auditEvents.entityId))
            .leftJoin(subject, eq(subject.id, auditEvents.entityId))
            .where(where)
            .orderBy(
        // Timestamps are to the second; two changes in the same second keep the
        // order they were written in (SQLite's rowid), not a random id's.
        ...(order === "asc"
            ? [asc(createdAtUtc), asc(sql `${auditEvents}.rowid`)]
            : [desc(createdAtUtc), desc(sql `${auditEvents}.rowid`)]))
            .limit(limit)
            .offset(offset)
            .all();
        // The same joins as above: the search reads through them, and a count
        // that skipped them would disagree with the page it is counting.
        const total = app.db
            .select({ count: sql `COUNT(*)` })
            .from(auditEvents)
            .innerJoin(actor, eq(actor.id, auditEvents.actorId))
            .leftJoin(lots, eq(lots.id, auditEvents.entityId))
            .leftJoin(customers, eq(customers.id, auditEvents.entityId))
            .leftJoin(projects, eq(projects.id, auditEvents.entityId))
            .leftJoin(contracts, eq(contracts.id, auditEvents.entityId))
            .leftJoin(subject, eq(subject.id, auditEvents.entityId))
            .where(where)
            .get();
        return reply.send({
            events: rows.map((row) => {
                const before = row.beforeJson
                    ? JSON.parse(row.beforeJson)
                    : null;
                return {
                    id: row.id,
                    action: row.action,
                    entityType: row.entityType,
                    entityId: row.entityId,
                    entityLabel: (row.entityType === "settings" ? SETTINGS_LABELS[row.entityId] : undefined) ??
                        row.lotCode ??
                        row.customerName ??
                        row.projectName ??
                        row.subjectName ??
                        row.contractCode ??
                        snapshotLabel(before),
                    actorName: row.actorName,
                    actorRole: row.actorRole,
                    reason: row.reason,
                    before,
                    after: row.afterJson ? JSON.parse(row.afterJson) : null,
                    createdAt: row.createdAt,
                };
            }),
            total: total?.count ?? 0,
            limit,
            offset,
        });
    });
};
//# sourceMappingURL=audit.js.map