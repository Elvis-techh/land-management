import { randomInt } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { constancias } from "../db/schema.js";

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
export function allocateConstanciaCode(isTaken: (code: string) => boolean): string {
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

/** A database or transaction handle — enough of one to void a constancia. */
type ConstanciaWriter = Pick<Db, "update">;

/**
 * Void the contract's standing constancia, if it has one.
 *
 * A constancia says the contract owes nothing. The moment that stops being true
 * — a payment reversed or corrected down and the balance reopens, or the
 * contract is cancelled or declared incumplido — the paper in the customer's
 * hands is wrong, so the record behind it is marked ANULADA, and that is what
 * looking its code up will say. The row and its code are kept: a constancia
 * that vanished cannot be told apart from one that never existed.
 *
 * Call inside the same transaction as the change that caused it.
 */
export function voidConstancias(
  db: ConstanciaWriter,
  contractId: string,
  reason: string,
  at: string = new Date().toISOString(),
): void {
  db.update(constancias)
    .set({ voidedAt: at, voidReason: reason })
    .where(and(eq(constancias.contractId, contractId), isNull(constancias.voidedAt)))
    .run();
}
