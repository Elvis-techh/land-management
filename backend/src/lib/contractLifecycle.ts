import { eq } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { contracts, payments } from "../db/schema.js";
import { voidConstancias } from "./constancias.js";
import { isReservationExpired } from "./contracts.js";
import { replayContract } from "./ledger.js";
import { ledgerChargesOf, loadMoraAccount } from "./moraAccounts.js";

/** A database or transaction handle — enough of one to read and settle a contract. */
type LifecycleWriter = Pick<Db, "select" | "update">;

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
 * Nothing is written to the Historial. A settle or a reopen is only ever the
 * consequence of a payment change, and that change is already in the history
 * under the person who made it — a second row saying the status followed would
 * be the same fact twice.
 *
 * The balance includes any mora charged and not paid, as of `at.asOf`: a
 * contract whose cuotas are complete but whose mora is not still owes money,
 * and its constancia would say otherwise.
 */
export function syncContractLifecycle(
  db: LifecycleWriter,
  contractId: string,
  at: { asOf: string; timeZone: string },
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
    charges: ledgerChargesOf(loadMoraAccount(db, contractId, at)),
  }).balanceCents;

  const target = balanceCents <= 0 ? "paid_off" : "active";

  if (target === contract.status) {
    return "unchanged";
  }

  db.update(contracts)
    .set({ status: target, updatedAt: new Date().toISOString() })
    .where(eq(contracts.id, contractId))
    .run();

  // A constancia says the contract owes nothing, which has just stopped being
  // true. See `voidConstancias`.
  if (target === "active") {
    voidConstancias(db, contractId, "El contrato volvió a tener saldo pendiente.");
  }

  return target === "paid_off" ? "settled" : "reopened";
}

/**
 * May money be posted to this contract today? `null` when it may, otherwise the
 * reason, in the words staff will read.
 *
 * Two things close a contract to money. A closed status (anything but `active`
 * or `paid_off`), written as the two that stay open so a closed status added
 * later is refused without anybody having to remember this function. And a
 * reservation past its date: it still reads `active`, because nothing sweeps
 * it, but its lot is free and may already belong to someone else, so money
 * posted here would be a balance on another customer's lot.
 */
export function moneyRefusal(
  contract: { code: string; status: string; kind: string; expiresOn: string | null },
  asOf: string,
): string | null {
  if (contract.status !== "active" && contract.status !== "paid_off") {
    return `El contrato ${contract.code} está cerrado y no admite pagos.`;
  }

  if (isReservationExpired(contract.kind, contract.status, contract.expiresOn, asOf)) {
    return (
      `La reserva ${contract.code} venció el ${contract.expiresOn} y su lote quedó libre. ` +
      "Renuévala con «Editar términos» (si el lote sigue libre) o conviértela en contrato " +
      "antes de cobrar."
    );
  }

  return null;
}
