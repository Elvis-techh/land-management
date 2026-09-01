import { eq } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { contracts, payments } from "../db/schema.js";
import { recordAudit } from "./audit.js";
import { replayContract } from "./ledger.js";

/** A database or transaction handle — enough of one to read and settle a contract. */
type LifecycleWriter = Pick<Db, "select" | "update" | "insert">;

/**
 * Move a contract between `active` and `paid_off` to match its replayed balance.
 *
 * Call this inside the same transaction as anything that changes what a
 * contract has been paid — a new receipt, a void, a corrected transaction, a
 * reprice. A contract whose balance has reached zero settles; one whose balance
 * reopens (a payment reversed, an amount corrected down, a price raised) goes
 * back to active.
 *
 * `cancelled` and `defaulted` are terminal — a human closed the contract for a
 * reason, and a later payment correction must not silently reopen it. Those are
 * left untouched here.
 *
 * The audit row is written against the actor who triggered the payment change.
 * There is always one, so this never needs a system user.
 */
export function syncContractLifecycle(
  db: LifecycleWriter,
  contractId: string,
  actorId: string,
): "settled" | "reopened" | "unchanged" {
  const contract = db
    .select({
      status: contracts.status,
      salePriceCents: contracts.salePriceCents,
    })
    .from(contracts)
    .where(eq(contracts.id, contractId))
    .get();

  if (!contract || (contract.status !== "active" && contract.status !== "paid_off")) {
    return "unchanged";
  }

  const credits = db
    .select({
      id: payments.id,
      amountCents: payments.amountCents,
      paidOn: payments.paidOn,
      createdAt: payments.createdAt,
      reversedAt: payments.reversedAt,
    })
    .from(payments)
    .where(eq(payments.contractId, contractId))
    .all();

  const balanceCents = replayContract({
    salePriceCents: contract.salePriceCents,
    credits,
  }).balanceCents;

  const target = balanceCents <= 0 ? "paid_off" : "active";

  if (target === contract.status) {
    return "unchanged";
  }

  db.update(contracts)
    .set({ status: target, updatedAt: new Date().toISOString() })
    .where(eq(contracts.id, contractId))
    .run();

  recordAudit(db, {
    actorId,
    entityType: "contract",
    entityId: contractId,
    action: target === "paid_off" ? "settle" : "reopen",
    before: { status: contract.status },
    after: { status: target, balanceCents },
  });

  return target === "paid_off" ? "settled" : "reopened";
}
