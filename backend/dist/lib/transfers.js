import { asc, eq, inArray } from "drizzle-orm";
import { contractTransfers, customers, users } from "../db/schema.js";
import { parseTimestamp } from "./time.js";
/**
 * Every transfer in the business, keyed by contract, oldest first, in one
 * query — the Contratos screen loads every contract at once, and asking once
 * per row is the N+1 that list is careful to avoid everywhere else.
 */
export function transfersByContract(db) {
    const rows = db
        .select({
        id: contractTransfers.id,
        contractId: contractTransfers.contractId,
        fromId: contractTransfers.fromCustomerId,
        toId: contractTransfers.toCustomerId,
        effectiveOn: contractTransfers.effectiveOn,
        reason: contractTransfers.reason,
        recordedAt: contractTransfers.createdAt,
        recordedBy: users.name,
    })
        .from(contractTransfers)
        .innerJoin(users, eq(users.id, contractTransfers.recordedBy))
        .orderBy(asc(contractTransfers.createdAt), asc(contractTransfers.id))
        .all();
    if (rows.length === 0) {
        return new Map();
    }
    // The names in a second query rather than joining `customers` twice, which
    // needs an alias: see docs/postgres-readiness.md.
    const people = new Map(db
        .select({ id: customers.id, fullName: customers.fullName })
        .from(customers)
        .where(inArray(customers.id, [...new Set(rows.flatMap((row) => [row.fromId, row.toId]))]))
        .all()
        .map((row) => [row.id, row.fullName]));
    const byContract = new Map();
    for (const row of rows) {
        const view = {
            id: row.id,
            from: { id: row.fromId, fullName: people.get(row.fromId) ?? "" },
            to: { id: row.toId, fullName: people.get(row.toId) ?? "" },
            effectiveOn: row.effectiveOn,
            reason: row.reason,
            recordedBy: row.recordedBy,
            recordedAt: row.recordedAt,
        };
        const list = byContract.get(row.contractId);
        if (list) {
            list.push(view);
        }
        else {
            byContract.set(row.contractId, [view]);
        }
    }
    return byContract;
}
/**
 * Who held this contract at an instant: the person a document issued then was
 * made out to.
 *
 * A receipt stores its own customer, so it never needs this. A constancia does
 * not — it reads the holder from the contract — and one issued to the previous
 * holder must keep their name after a transfer, voided or not.
 *
 * Measured against when each transfer was ENTERED, not the day it says it was
 * signed: what decides the name on a document is who the app said held the
 * contract when the document was made. Compared as parsed instants, because
 * this database holds timestamps in two shapes (see src/lib/time.ts).
 */
export function holderAt(db, contractId, at, currentHolderId) {
    const instant = parseTimestamp(at);
    const next = db
        .select({ fromCustomerId: contractTransfers.fromCustomerId, createdAt: contractTransfers.createdAt })
        .from(contractTransfers)
        .where(eq(contractTransfers.contractId, contractId))
        .all()
        .filter((transfer) => parseTimestamp(transfer.createdAt) > instant)
        .sort((a, b) => parseTimestamp(a.createdAt) - parseTimestamp(b.createdAt))[0];
    // The first hand-over after that instant was made BY the holder of the time.
    return next?.fromCustomerId ?? currentHolderId;
}
//# sourceMappingURL=transfers.js.map