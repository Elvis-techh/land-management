import type { ViewerFile } from "../../components/DocumentViewer";
import { ApiError, api } from "../../lib/api";
import { CLIENT_ID } from "../../lib/liveUpdates";
import { cents } from "../../lib/money";
import type { Contract, ContractDocument } from "../../types";
import type { MoraSettings } from "../settings/api";

/**
 * Exactly what GET /api/contracts sends back.
 *
 * Money arrives as plain JSON numbers, because JSON has no way to say "these
 * are centavos". The branding to `Cents` happens in `fetchContracts` below, at
 * the boundary — past that point TypeScript refuses to let a raw number stand
 * in for money.
 */
interface ContractsResponse {
  contracts: Array<
    Omit<Contract, "terms" | "health" | "downPaymentPaid" | "paidToDate" | "balance" | "mora"> & {
      terms: {
        salePrice: number;
        downPayment: number;
        financed: number;
        termMonths: number | null;
        monthlyPayment: number | null;
        dueDay: number | null;
        signedOn: string;
        firstDueOn: string | null;
        firstDueOnAgreed: string | null;
        expiresOn: string | null;
      };
      downPaymentPaid: number;
      paidToDate: number;
      balance: number;
      mora: { charged: number; paid: number; forgiven: number; pending: number };
      health: {
        status: Contract["health"]["status"];
        arrears: number;
        monthsBehind: number;
        downPaymentLate: boolean;
        monthsAhead: number;
        nextDueOn: string | null;
        nextDueAmount: number;
        nextInstallment: number;
        nextDueCredit: number;
        nextDueIsDownPayment: boolean;
        settled: boolean;
      };
    }
  >;
}

export async function fetchContracts(): Promise<Contract[]> {
  const response = await api.get<ContractsResponse>("/api/contracts");

  return response.contracts.map((contract) => ({
    ...contract,
    terms: {
      ...contract.terms,
      salePrice: cents(contract.terms.salePrice),
      downPayment: cents(contract.terms.downPayment),
      financed: cents(contract.terms.financed),
      monthlyPayment:
        contract.terms.monthlyPayment === null ? null : cents(contract.terms.monthlyPayment),
    },
    downPaymentPaid: cents(contract.downPaymentPaid),
    paidToDate: cents(contract.paidToDate),
    balance: cents(contract.balance),
    mora: {
      charged: cents(contract.mora.charged),
      paid: cents(contract.mora.paid),
      forgiven: cents(contract.mora.forgiven),
      pending: cents(contract.mora.pending),
    },
    health: {
      ...contract.health,
      arrears: cents(contract.health.arrears),
      nextDueAmount: cents(contract.health.nextDueAmount),
      nextInstallment: cents(contract.health.nextInstallment),
      nextDueCredit: cents(contract.health.nextDueCredit),
    },
  }));
}

/** One line of a proposed split — what each lot would take of a single payment. */
export interface SplitLine {
  contractId: string;
  contractCode: string;
  lotCode: string;
  amountCents: number;
  balanceBefore: number;
  balanceAfter: number;
  /**
   * The total handed over was not enough to cover this lot's own next
   * installment, even after the server favored the smallest ones first.
   */
  belowMinimum: boolean;
}

/**
 * How one payment would be divided across a purchase, WITHOUT posting anything.
 *
 * The rule lives on the server (src/lib/allocation.ts): equal shares to the
 * centavo, never more than a lot owes nor less than its next installment. This
 * is a preview, so the amounts can be seen and argued with before any money is
 * recorded.
 */
export function fetchSplit(saleGroupId: string, amountCents: number) {
  return api.get<{ amountCents: number; unallocatedCents: number; lines: SplitLine[] }>(
    `/api/contracts/groups/${saleGroupId}/split?amountCents=${amountCents}`,
  );
}

/**
 * The terms as the edit form sends them back.
 *
 * Whole centavos, never lempiras — the dialog converts before it gets here, so
 * there is exactly one place where the unit changes. The lot and the customer
 * are absent on purpose: the server refuses to move either, because a different
 * lot is a different sale rather than an edit to this one.
 */
export interface ContractTermsDraft {
  kind: Contract["kind"];
  saleType: Contract["saleType"];
  salePriceCents: number;
  downPaymentCents: number;
  termMonths: number | null;
  monthlyPaymentCents: number | null;
  dueDay: number | null;
  signedOn: string;
  /** Only when it was negotiated. `null` lets it follow from `signedOn`. */
  firstDueOn: string | null;
  expiresOn: string | null;
  notes: string | null;
  /** Required for every edit — the server refuses without it. */
  reason: string;
}

export function updateContract(contractId: string, draft: ContractTermsDraft) {
  return api.patch<{ contract: { id: string; code: string } }>(
    `/api/contracts/${contractId}`,
    draft,
  );
}

/**
 * Correct the lot on a signed contract — a data-entry mistake, not a new sale.
 *
 * Its own endpoint, separate from `updateContract`: everywhere else in this
 * app a different lot means a different sale, and that stays true here too —
 * this is a distinct, audited correction, not a field on the regular edit.
 * What it spares the office is undoing every payment already recorded against
 * the wrong lot; the balance and every past receipt follow the contract to
 * its corrected lot automatically.
 */
export function reassignContractLot(contractId: string, lotId: string, reason: string) {
  return api.post<{ contract: { id: string; code: string } }>(
    `/api/contracts/${contractId}/reassign-lot`,
    { lotId, reason },
  );
}

/** What happens to money the customer already paid — see ContractCancelDialog. */
export type CancelSettlement = "none" | "held" | "refunded";

interface CloseResult {
  ok: boolean;
  closedAt: string;
  settlement: CancelSettlement | null;
  refundedCents: number;
}

export function cancelContract(
  contractId: string,
  reason: string,
  settlement?: CancelSettlement,
) {
  return api.post<CloseResult>(`/api/contracts/${contractId}/cancel`, { reason, settlement });
}

/**
 * Declare a contract uncollectable — the customer defaulted. Owner only.
 *
 * The same shape as `cancelContract`: same settlement question, same refund
 * path. It is a separate action because a default is the business writing off
 * what it is owed, and a cancellation is a sale unwound by agreement — and the
 * two need to be told apart in the history and the stats.
 */
export function defaultContract(
  contractId: string,
  reason: string,
  settlement?: CancelSettlement,
) {
  return api.post<CloseResult>(`/api/contracts/${contractId}/default`, { reason, settlement });
}

/**
 * A brand-new contract, as the "Nuevo contrato" form sends it.
 *
 * The lot and the customer are present here and absent from
 * `ContractTermsDraft` above, and that is the whole difference between the two:
 * choosing them is what CREATES a sale, and neither can be moved afterwards
 * because a different lot is a different sale rather than a correction.
 *
 * Money is whole centavos, converted by the dialog before it gets here. The
 * contract NUMBER is not sent: the server assigns it, so two people entering
 * contracts at the same time cannot land on CT-2026-014 together.
 */
export interface ContractCreateDraft {
  customerId: string;
  lotId: string;
  kind: Contract["kind"];
  saleType: Contract["saleType"];
  salePriceCents: number;
  downPaymentCents: number;
  termMonths: number | null;
  monthlyPaymentCents: number | null;
  dueDay: number | null;
  signedOn: string;
  /** Only when it was negotiated. `null` lets it follow from `signedOn`. */
  firstDueOn: string | null;
  expiresOn: string | null;
  notes: string | null;
  /**
   * The contract this one is bought together with — the second or third lot of
   * a single purchase. The server puts both into one sale group, which is what
   * later lets a single payment be split across them.
   */
  joinGroupOfContractId: string | null;
}

export function createContract(draft: ContractCreateDraft) {
  return api.post<{ contract: { id: string; code: string; saleGroupId: string | null } }>(
    "/api/contracts",
    draft,
  );
}

/**
 * An adenda, as the "Adenda" dialog sends it — see POST /api/contracts/amendments.
 *
 * The schedule (forma de pago, plazo, día, primera cuota) is one for the whole
 * agreement; only the money is per lot, because the new total is divided
 * between lots that need not be the same size. Whole centavos throughout.
 */
export interface AmendmentDraft {
  /** YYYY-MM-DD: the day the new terms were agreed. The new contracts are signed on it. */
  effectiveOn: string;
  saleType: "financed" | "cash";
  termMonths: number | null;
  dueDay: number | null;
  /** Only when it was negotiated. `null` lets it follow from `effectiveOn`. */
  firstDueOn: string | null;
  lines: Array<{
    /** The running contract this line replaces. */
    contractId: string;
    salePriceCents: number;
    downPaymentCents: number;
    monthlyPaymentCents: number | null;
  }>;
  authorizedBy: string | null;
  reason: string;
}

export function amendContracts(draft: AmendmentDraft) {
  return api.post<{
    amendment: { id: string };
    contracts: Array<{ id: string; code: string; replacesContractId: string }>;
  }>("/api/contracts/amendments", draft);
}

/* -------------------------------------------------------------------------- */
/* The signed paperwork                                                        */
/* -------------------------------------------------------------------------- */

/** Every document filed against one contract, oldest first. */
export async function fetchContractDocuments(contractId: string): Promise<ContractDocument[]> {
  const response = await api.get<{ documents: ContractDocument[] }>(
    `/api/contracts/${contractId}/documents`,
  );

  return response.documents;
}

/**
 * File the signed contract against the contract record.
 *
 * Sent as multipart rather than JSON, for the same reason a comprobante is: a
 * base64 scan inflates by a third and has to be held in memory as one enormous
 * string on both ends, where a multipart body streams. A fifteen-page contract
 * is where that stops being theoretical. The browser sets the Content-Type
 * header itself — only it knows the boundary — so `api.post` is bypassed here.
 */
export async function uploadContractDocument(
  contractId: string,
  file: File,
): Promise<ContractDocument> {
  const body = new FormData();
  body.append("file", file);

  const response = await fetch(`/api/contracts/${contractId}/documents`, {
    method: "POST",
    credentials: "include",
    // `api.post` is bypassed here, so this header has to be repeated: without
    // it the server cannot tell whose write this was, and the uploading tab
    // refreshes itself for news it already has. See lib/liveUpdates.ts.
    headers: { "X-Client-Id": CLIENT_ID },
    body,
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const error = payload as { message?: string } | null;
    // A 413 without a message of ours is Nginx refusing the body before
    // Lindero ever saw it — its limit, whatever ours says. Name the problem
    // rather than the generic failure, but no number: its limit may differ.
    const fallback =
      response.status === 413
        ? "El archivo es demasiado grande para el servidor."
        : "No se pudo subir el documento.";

    throw new ApiError(response.status, error?.message ?? fallback);
  }

  return (payload as { document: ContractDocument }).document;
}

export function deleteContractDocument(documentId: string) {
  return api.delete<{ ok: true }>(`/api/contract-documents/${documentId}`);
}

/**
 * Where the browser can fetch a document's bytes. Behind the session.
 *
 * Served for VIEWING — inline, in an opaque origin — so putting this in an
 * `<iframe>` shows the contract rather than saving a copy of it to whatever
 * machine is being used. See routes/contracts.ts for how that is made safe.
 */
export function contractDocumentUrl(documentId: string): string {
  return `/api/contract-documents/${documentId}/file`;
}

/** A filed document, in the shape the viewer and the thumbnails want. */
export function storedDocument(document: ContractDocument): ViewerFile {
  return {
    id: document.id,
    name: document.fileName,
    contentType: document.contentType,
    url: contractDocumentUrl(document.id),
    caption: `Subido por ${document.uploadedBy}`,
    sizeBytes: document.byteSize,
  };
}

/** One mora put on by hand («Cargar mora»). Amounts in lempira centavos. */
export interface ManualMora {
  id: string;
  /** 0 for the prima, otherwise the cuota's number. */
  installment: number;
  /** YYYY-MM-DD, the day it was charged or agreed. */
  incurredOn: string;
  amountCents: number;
  /** What is still unpaid of it. 0 once a payment has covered it. */
  pendingCents: number;
  reason: string;
  recordedBy: string;
  recordedAt: string;
}

/** One «Perdonar»: mora charged and not paid, forgiven on one cuota. Amounts in lempira centavos. */
export interface ForgivenMora {
  id: string;
  /** 0 for the prima, otherwise the cuota's number. */
  installment: number;
  /** YYYY-MM-DD, the day it was entered. */
  forgivenOn: string;
  amountCents: number;
  /**
   * What it actually cleared. Less than `amountCents` only when a payment
   * entered later, with an earlier date, had already paid part of that mora.
   */
  clearedCents: number;
  reason: string;
  recordedBy: string;
  recordedAt: string;
}

/** What a contract's own rule («Regla propia») sets. The rest stays the general rule's. */
export type OwnMoraRules = Pick<
  MoraSettings,
  "calculation" | "percent" | "fixedCents" | "capCents" | "minUnpaidCents" | "frequency"
>;

/** A contract's own mora rule. "general" follows Configuración. */
export type ContractMoraRule =
  | { mode: "general" }
  | { mode: "none" }
  | { mode: "own"; rules: OwnMoraRules };

/** One version of a contract's rule, in force from `effectiveFrom` until the next. */
export interface ContractMoraRuleVersion {
  id: string;
  /** YYYY-MM-DD. The last version may start tomorrow. */
  effectiveFrom: string;
  rule: ContractMoraRule;
  reason: string;
  recordedBy: string;
  recordedAt: string;
}

/** One contract's mora, for its panel. See GET /contracts/:id/mora. */
export interface ContractMora {
  /** Whether this contract can take mora at all: a signed credit sale, still open. */
  chargeable: boolean;
  manual: ManualMora[];
  /** Mora forgiven with «Perdonar», oldest first. */
  forgiven: ForgivenMora[];
  /** Mora charged and neither paid nor forgiven, by cuota: what «Perdonar» can clear. */
  pendingByInstallment: Record<number, number>;
  /** The automatic mora charged so far, by cuota (0 for the prima). */
  automaticByInstallment: Record<number, number>;
  /** The prima and the cuotas already due, which are the ones mora can go on. */
  due: Array<{ installment: number; dueOn: string }>;
  /** Its own rule, oldest first. Empty while it has always followed the general one. */
  rules: ContractMoraRuleVersion[];
  /** The general rule, from Configuración. */
  general: MoraSettings;
}

export function fetchContractMora(contractId: string): Promise<ContractMora> {
  return api.get<ContractMora>(`/api/contracts/${contractId}/mora`);
}

export function chargeContractMora(
  contractId: string,
  entry: { installment: number; incurredOn: string; amountCents: number; reason: string },
) {
  return api.post<{ id: string }>(`/api/contracts/${contractId}/mora`, entry);
}

export function removeContractMora(contractId: string, chargeId: string, reason: string) {
  return api.post<{ ok: true }>(`/api/contracts/${contractId}/mora/${chargeId}/remove`, { reason });
}

/** «Perdonar»: forgive all or part of one cuota's unpaid mora, from now on. */
export function forgiveContractMora(
  contractId: string,
  entry: { installment: number; amountCents: number; reason: string },
) {
  return api.post<{ id: string }>(`/api/contracts/${contractId}/mora/forgive`, entry);
}

export function unforgiveContractMora(contractId: string, forgivenessId: string, reason: string) {
  return api.post<{ ok: true }>(`/api/contracts/${contractId}/mora/forgiven/${forgivenessId}/remove`, { reason });
}

/** Give a contract its own mora rule, or put it back on the general one. From tomorrow. */
export function setContractMoraRule(contractId: string, rule: ContractMoraRule & { reason: string }) {
  return api.post<{ effectiveFrom: string }>(`/api/contracts/${contractId}/mora/rule`, rule);
}
