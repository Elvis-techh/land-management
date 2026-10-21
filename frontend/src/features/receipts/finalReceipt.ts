import type { Receipt } from "../../types";

/** Everything the check below reads. */
export type FinalReceiptFields = Pick<Receipt, "newBalance" | "voidedAt">;

/**
 * Whether this receipt is the one that paid everything on it off: the
 * «RECIBO DE PAGO FINAL», with a green «Saldo Cancelado» instead of a red zero.
 *
 * Read from the balance the receipt itself prints, so the title can never
 * disagree with the figure under it. On a multi-lot receipt that is the sum of
 * its lots, so it is final only when every lot on it is paid off. A voided
 * receipt is never final: its money no longer counts, and a document that says
 * both ANULADO and «pagado en su totalidad» contradicts itself.
 */
export function isFinalReceipt(receipt: FinalReceiptFields): boolean {
  return receipt.voidedAt === null && receipt.newBalance === 0;
}
