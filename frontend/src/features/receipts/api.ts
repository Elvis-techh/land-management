import { ApiError, api } from "../../lib/api";
import { cents } from "../../lib/money";
import type { Receipt, ReceiptLine, Transaction } from "../../types";

/**
 * Exactly what the receipts endpoints send back. Money arrives as whole
 * centavos and is branded at this boundary, as it is for lots and customers —
 * JSON has no way to say "this number is centavos", so past this point
 * TypeScript will not let a plain number be used where money is expected.
 */
interface ReceiptResponse {
  id: string;
  number: number;
  code: string;
  lookupCode: string;
  issuedOn: string;
  note: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  supersededById: string | null;
  customer: { id: string; fullName: string; identification: string; phone: string };
  issuedBy: { id: string; name: string };
  totalPaid: number;
  previousBalance: number;
  newBalance: number;
  cumulativePaid: number;
  transactionCount: number;
  method: string | null;
  attachments?: Array<{
    id: string;
    fileName: string;
    contentType: string;
    byteSize: number;
    createdAt: string;
  }>;
  lines?: Array<{
    paymentId: string;
    contractId: string;
    contractCode: string | null;
    lotCode: string | null;
    projectName: string | null;
    amount: number;
    type: string;
    contractTotal: number;
    installmentCount: number;
    previousBalance: number;
    newBalance: number;
    appliedTo: Array<{ number: number; dueOn: string; appliedCents: number; settled: boolean }>;
  }>;
}

function toLine(line: NonNullable<ReceiptResponse["lines"]>[number]): ReceiptLine {
  return {
    ...line,
    amount: cents(line.amount),
    contractTotal: cents(line.contractTotal),
    previousBalance: cents(line.previousBalance),
    newBalance: cents(line.newBalance),
    appliedTo: line.appliedTo.map((installment) => ({
      ...installment,
      applied: cents(installment.appliedCents),
    })),
  };
}

function toReceipt(receipt: ReceiptResponse): Receipt {
  return {
    ...receipt,
    totalPaid: cents(receipt.totalPaid),
    previousBalance: cents(receipt.previousBalance),
    newBalance: cents(receipt.newBalance),
    cumulativePaid: cents(receipt.cumulativePaid),
    lines: receipt.lines?.map(toLine) ?? [],
    attachments: receipt.attachments ?? [],
  };
}

export async function fetchReceipt(receiptId: string): Promise<Receipt> {
  const response = await api.get<{ receipt: ReceiptResponse }>(`/api/receipts/${receiptId}`);
  return toReceipt(response.receipt);
}

/**
 * Every posted transaction, newest first.
 *
 * One request behind BOTH views of the screen — the flat list by date and the
 * grouped list by customer. Grouping happens in `transactionSort.ts`, from this
 * single array, so the two views can never disagree about what exists.
 */
export async function fetchTransactions(): Promise<Transaction[]> {
  const response = await api.get<{
    transactions: Array<Omit<Transaction, "amount" | "originalAmount"> & {
      amount: number;
      originalAmount: number;
    }>;
  }>("/api/transactions");

  return response.transactions.map((transaction) => ({
    ...transaction,
    amount: cents(transaction.amount),
    originalAmount: cents(transaction.originalAmount),
  }));
}

/** One lot's share of an amount, as the server proposes dividing it. */
export interface SplitLine {
  contractId: string;
  contractCode: string;
  lotCode: string;
  projectName: string;
  amountCents: number;
  balanceBefore: number;
  balanceAfter: number;
}

/**
 * How one amount would divide across everything this customer is paying on.
 *
 * A PROPOSAL, computed by the server so this screen and the payment that gets
 * recorded cannot disagree about the arithmetic. Every line stays editable
 * afterwards — see `NewReceiptDialog`.
 */
export async function fetchCustomerSplit(
  customerId: string,
  amountCents: number,
): Promise<{ lines: SplitLine[]; unallocatedCents: number }> {
  return api.get(`/api/customers/${customerId}/split?amountCents=${amountCents}`);
}

/**
 * Correct a posted transaction.
 *
 * The reason is not optional: this is the one place in the app where a
 * financial fact is rewritten in place rather than reversed, and the audit
 * entry is the only record that the previous figure ever existed.
 */
export interface TransactionEdit {
  amountCents: number;
  paidOn: string;
  method: "cash" | "transfer" | "card";
  type: "down_payment" | "installment" | "full_payment" | "adjustment";
  reference: string | null;
  notes: string | null;
  reason: string;
  allowOverpayment?: boolean;
}

export function updateTransaction(transactionId: string, edit: TransactionEdit) {
  return api.patch<{ transaction: unknown }>(`/api/transactions/${transactionId}`, edit);
}

/* -------------------------------------------------------------------------- */
/* Proof of payment                                                            */
/* -------------------------------------------------------------------------- */

export interface UploadedAttachment {
  id: string;
  fileName: string;
  contentType: string;
  byteSize: number;
}

/**
 * Attach the customer's proof of transfer to a receipt.
 *
 * Sent as multipart rather than JSON: a base64 image inflates by a third and
 * has to be held in memory as one enormous string on both ends, where a
 * multipart body streams. The browser sets the Content-Type header itself — it
 * has to, because only it knows the boundary — so `api.post` is bypassed here.
 */
export async function uploadAttachment(
  receiptId: string,
  file: File,
): Promise<UploadedAttachment> {
  const body = new FormData();
  body.append("file", file);

  const response = await fetch(`/api/receipts/${receiptId}/attachments`, {
    method: "POST",
    credentials: "include",
    body,
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const error = payload as { message?: string } | null;
    throw new ApiError(response.status, error?.message ?? "No se pudo subir el comprobante.");
  }

  return (payload as { attachment: UploadedAttachment }).attachment;
}

export function deleteAttachment(attachmentId: string) {
  return api.delete<{ ok: true }>(`/api/attachments/${attachmentId}`);
}

/** Where the browser can fetch an attachment's bytes. Behind the session. */
export function attachmentUrl(attachmentId: string): string {
  return `/api/attachments/${attachmentId}/file`;
}

/** One lot's line on a receipt being written. Amounts are in lempira centavos. */
export interface ReceiptDraftLine {
  contractId: string;
  amountCents: number;
  type: "down_payment" | "installment" | "full_payment" | "adjustment";
  notes?: string | null;
}

export interface ReceiptDraft {
  customerId: string;
  /** YYYY-MM-DD. Back-dating is allowed and is the point. */
  paidOn: string;
  method: "cash" | "transfer" | "card";
  reference?: string | null;
  note?: string | null;
  originalCurrency?: "HNL" | "USD";
  exchangeRate?: string;
  /**
   * The client's own key for this submission, so a double-tap on a phone with
   * one bar of signal cannot post the money twice. Generated once per open
   * form, not per attempt — a retry has to carry the SAME key or it defeats the
   * purpose.
   */
  idempotencyKey: string;
  /** Deliberate acknowledgement that a line exceeds what its contract owes. */
  allowOverpayment?: boolean;
  lines: ReceiptDraftLine[];
}

/**
 * Post a receipt.
 *
 * Resolves with `duplicate: true` when the server recognised the idempotency
 * key and handed back the receipt it had already issued, rather than taking the
 * money a second time.
 */
export async function createReceipt(
  draft: ReceiptDraft,
): Promise<{ receipt: Receipt; duplicate: boolean }> {
  const response = await api.post<{ receipt: ReceiptResponse; duplicate?: boolean }>(
    "/api/receipts",
    draft,
  );

  return { receipt: toReceipt(response.receipt), duplicate: response.duplicate === true };
}

/**
 * Void a receipt and reverse the money on it.
 *
 * Nothing is deleted and the number is never reused — see the note on the
 * `receipts` table in the backend schema.
 */
export async function voidReceipt(receiptId: string, reason: string): Promise<Receipt> {
  const response = await api.post<{ receipt: ReceiptResponse }>(
    `/api/receipts/${receiptId}/void`,
    { reason },
  );

  return toReceipt(response.receipt);
}
