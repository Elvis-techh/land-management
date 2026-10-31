import { randomInt } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { constanciaContracts, constancias, contracts } from "../db/schema.js";
/**
 * How a «Constancia de Cancelación Total» is identified, and how it stops
 * counting.
 *
 * The same three identifiers as a receipt, for the same reasons — see
 * src/lib/receipts.ts. A gapless internal number, never printed; a random
 * printed code, so the paper does not say how many lots have been paid off;
 * and the receipt-style lookup code the office types in to verify one.
 */
/**
 * «Constancia de Cancelación». Not "CT", which is what contract numbers start
 * with: a constancia CT-06158187 for contract CT-2026-023 is two codes that look
 * like the same kind of thing.
 */
const CODE_PREFIX = "CC";
/** Eight digits: fewer documents than receipts, and the same width on every one. */
const CODE_DIGITS = 8;
/** What a printed constancia code looks like. Exported for the tests. */
export const CONSTANCIA_CODE_PATTERN = new RegExp(`^${CODE_PREFIX}-\\d{${CODE_DIGITS}}$`);
/** A constancia code not already issued. See `allocateReceiptCode` for the loop. */
export function allocateConstanciaCode(isTaken) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
        let digits = "";
        for (let index = 0; index < CODE_DIGITS; index += 1) {
            digits += String(randomInt(10));
        }
        const code = `${CODE_PREFIX}-${digits}`;
        if (!isTaken(code)) {
            return code;
        }
    }
    throw new Error("No se pudo generar un número de constancia único.");
}
/**
 * Void every standing constancia that speaks for this contract — its own, and
 * any combined one it is part of.
 *
 * A constancia says the contract owes nothing. The moment that stops being true
 * — a payment reversed or corrected down and the balance reopens, or the
 * contract is cancelled or declared incumplido — the paper in the customer's
 * hands is wrong, so the record behind it is marked ANULADA, and that is what
 * looking its code up will say. A combined constancia is voided whole: it is
 * one statement about all its lots, and it is no longer true of one of them.
 * The reason names the contract, so a combined one says which lot did it. The
 * rows and their codes are kept: a constancia that vanished cannot be told
 * apart from one that never existed.
 *
 * Call inside the same transaction as the change that caused it.
 */
export function voidConstancias(db, contractId, reason, at = new Date().toISOString()) {
    const ids = db
        .select({ id: constanciaContracts.constanciaId })
        .from(constanciaContracts)
        .where(eq(constanciaContracts.contractId, contractId))
        .all()
        .map((row) => row.id);
    if (ids.length === 0) {
        return;
    }
    const code = db
        .select({ code: contracts.code })
        .from(contracts)
        .where(eq(contracts.id, contractId))
        .get()?.code;
    db.update(constancias)
        .set({ voidedAt: at, voidReason: code ? `${reason} (contrato ${code})` : reason })
        .where(and(inArray(constancias.id, ids), isNull(constancias.voidedAt)))
        .run();
}
//# sourceMappingURL=constancias.js.map