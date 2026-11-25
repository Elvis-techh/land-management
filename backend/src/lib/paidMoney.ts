import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { contractRefunds, contracts, payments, users } from "../db/schema.js";

/**
 * «Trasladar lo pagado»: what became of money paid on a contract that is no
 * longer running.
 *
 * Until an adenda (or, later, a cancellation) decides otherwise, everything
 * paid on the old contract stays there as income — that is still the default.
 * From here it can go two other ways, and every lempira is accounted for:
 *
 * - a TRASLADO to the contract that replaced it: a payment row on the new
 *   contract carrying `transferred_from_contract_id` (see that column);
 * - a DEVOLUCIÓN to whoever paid it: a row in `contract_refunds`, owed until
 *   the day it is handed back.
 *
 * What is left over still counts as income. Nothing here rewrites a payment
 * or a receipt of the old contract.
 */

/** The method a traslado is stored with: no money changed hands that day. */
export const CARRYOVER_METHOD = "carryover";

/** One traslado, seen from either end. */
export interface CarryoverView {
  paymentId: string;
  /** The contract at the OTHER end: where it went, or where it came from. */
  contractId: string;
  code: string;
  amountCents: number;
  /** YYYY-MM-DD, the day it counts from on the new contract. */
  on: string;
  /** "down_payment" | "installment" — what it counts as on the new contract. */
  type: string;
}

/** One devolución. */
export interface RefundView {
  id: string;
  amountCents: number;
  reason: string;
  recordedBy: string;
  recordedAt: string;
  /** YYYY-MM-DD, or null while it is still owed. */
  returnedOn: string | null;
  method: string | null;
  reference: string | null;
}

export interface PaidMoneyMoves {
  /** Keyed by the contract the money LEFT. */
  out: Map<string, { carryovers: CarryoverView[]; refunds: RefundView[] }>;
  /** Keyed by the contract the money ARRIVED on. */
  in: Map<string, CarryoverView[]>;
}

/**
 * Every traslado and devolución that still stands, for the Contratos screen, in
 * three small queries whatever the size of the business.
 */
export function paidMoneyMoves(db: Db): PaidMoneyMoves {
  const carried = db
    .select({
      paymentId: payments.id,
      toId: payments.contractId,
      fromId: payments.transferredFromContractId,
      amountCents: payments.amountCents,
      on: payments.paidOn,
      type: payments.type,
    })
    .from(payments)
    .where(and(isNotNull(payments.transferredFromContractId), isNull(payments.reversedAt)))
    .all();

  const refunds = db
    .select({
      id: contractRefunds.id,
      contractId: contractRefunds.contractId,
      amountCents: contractRefunds.amountCents,
      reason: contractRefunds.reason,
      recordedBy: users.name,
      recordedAt: contractRefunds.createdAt,
      returnedOn: contractRefunds.returnedOn,
      method: contractRefunds.method,
      reference: contractRefunds.reference,
    })
    .from(contractRefunds)
    .innerJoin(users, eq(users.id, contractRefunds.recordedBy))
    .where(isNull(contractRefunds.removedAt))
    .all();

  const moves: PaidMoneyMoves = { out: new Map(), in: new Map() };

  if (carried.length === 0 && refunds.length === 0) {
    return moves;
  }

  const ids = [...new Set(carried.flatMap((row) => [row.toId, row.fromId!]))];
  const codeOf = new Map(
    ids.length === 0
      ? []
      : db
          .select({ id: contracts.id, code: contracts.code })
          .from(contracts)
          .where(inArray(contracts.id, ids))
          .all()
          .map((row) => [row.id, row.code]),
  );

  const outOf = (contractId: string) => {
    let entry = moves.out.get(contractId);
    if (!entry) {
      entry = { carryovers: [], refunds: [] };
      moves.out.set(contractId, entry);
    }
    return entry;
  };

  for (const row of carried) {
    const base = { paymentId: row.paymentId, amountCents: row.amountCents, on: row.on, type: row.type };
    outOf(row.fromId!).carryovers.push({ ...base, contractId: row.toId, code: codeOf.get(row.toId) ?? "" });
    const list = moves.in.get(row.toId) ?? [];
    list.push({ ...base, contractId: row.fromId!, code: codeOf.get(row.fromId!) ?? "" });
    moves.in.set(row.toId, list);
  }

  for (const row of refunds) {
    const { contractId, ...view } = row;
    outOf(contractId).refunds.push(view);
  }

  return moves;
}

/**
 * What is still undecided on one contract: paid on it, minus what was moved on
 * and what is to be (or was) given back. That is what still counts as income,
 * and the most another traslado or devolución can take.
 *
 * Summed here rather than in SQL, over one contract's rows.
 */
export function undecidedCents(db: Pick<Db, "select">, contractId: string): number {
  const paid = db
    .select({ amountCents: payments.amountCents })
    .from(payments)
    .where(and(eq(payments.contractId, contractId), isNull(payments.reversedAt)))
    .all()
    .reduce((total, row) => total + row.amountCents, 0);

  const carried = db
    .select({ amountCents: payments.amountCents })
    .from(payments)
    .where(and(eq(payments.transferredFromContractId, contractId), isNull(payments.reversedAt)))
    .all()
    .reduce((total, row) => total + row.amountCents, 0);

  const refunded = db
    .select({ amountCents: contractRefunds.amountCents })
    .from(contractRefunds)
    .where(and(eq(contractRefunds.contractId, contractId), isNull(contractRefunds.removedAt)))
    .all()
    .reduce((total, row) => total + row.amountCents, 0);

  return paid - carried - refunded;
}
