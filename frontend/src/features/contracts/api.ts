import { api } from "../../lib/api";
import { cents } from "../../lib/money";
import type { Contract } from "../../types";

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
    Omit<Contract, "terms" | "health" | "downPaymentPaid" | "paidToDate" | "balance"> & {
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
      health: {
        status: Contract["health"]["status"];
        arrears: number;
        monthsBehind: number;
        monthsAhead: number;
        nextDueOn: string | null;
        nextDueAmount: number;
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
    health: {
      ...contract.health,
      arrears: cents(contract.health.arrears),
      nextDueAmount: cents(contract.health.nextDueAmount),
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
}

/**
 * How one payment would be divided across a purchase, WITHOUT posting anything.
 *
 * The rule lives on the server (src/lib/allocation.ts): equal shares rounded to
 * whole hundreds, with the odd remainder going to the lot that owes the most so
 * it evens out over the months. This is a preview, so the amounts can be seen
 * and argued with before any money is recorded.
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

/** What happens to money the customer already paid — see ContractCancelDialog. */
export type CancelSettlement = "none" | "held" | "refunded";

export function cancelContract(
  contractId: string,
  reason: string,
  settlement?: CancelSettlement,
) {
  return api.post<{
    ok: boolean;
    closedAt: string;
    settlement: CancelSettlement | null;
    refundedCents: number;
  }>(`/api/contracts/${contractId}/cancel`, { reason, settlement });
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
