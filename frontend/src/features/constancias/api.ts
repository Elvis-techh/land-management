import { api } from "../../lib/api";
import type { Cents } from "../../lib/money";
import { cents } from "../../lib/money";

/**
 * A «Constancia de Cancelación Total», as the document needs it. Every figure
 * is read from the contract's payments by the server; see
 * backend/src/routes/constancias.ts.
 */
export interface Constancia {
  id: string;
  /** Printed: "CC-48273915". */
  code: string;
  /** "K7M2-9XQR", what the office types in to verify it. */
  lookupCode: string;
  issuedOn: string;
  issuedBy: { name: string };
  /** Set once the contract stopped being paid off. The paper is then ANULADA. */
  voidedAt: string | null;
  voidReason: string | null;
  contract: { id: string; code: string; salePrice: Cents; signedOn: string | null };
  lot: { code: string; projectName: string };
  customer: { fullName: string; identification: string | null };
  payments: Array<{ paidOn: string; type: string; amount: Cents; receiptCode: string | null }>;
  totalPaid: Cents;
  lastPaidOn: string | null;
}

interface ConstanciaResponse extends Omit<Constancia, "contract" | "payments" | "totalPaid"> {
  contract: { id: string; code: string; salePriceCents: number; signedOn: string | null };
  payments: Array<{ paidOn: string; type: string; amountCents: number; receiptCode: string | null }>;
  totalPaidCents: number;
}

/** Money is branded at this boundary, as everywhere else. */
function toConstancia({ contract, payments, totalPaidCents, ...rest }: ConstanciaResponse): Constancia {
  return {
    ...rest,
    contract: {
      id: contract.id,
      code: contract.code,
      salePrice: cents(contract.salePriceCents),
      signedOn: contract.signedOn,
    },
    payments: payments.map(({ amountCents, ...payment }) => ({ ...payment, amount: cents(amountCents) })),
    totalPaid: cents(totalPaidCents),
  };
}

/** The contract's standing constancia, or null when none has been issued (or it was voided). */
export async function fetchContractConstancia(contractId: string): Promise<Constancia | null> {
  const response = await api.get<{ constancia: ConstanciaResponse | null }>(
    `/api/contracts/${contractId}/constancia`,
  );

  return response.constancia && toConstancia(response.constancia);
}

/** Issue it — or get back the one already standing. */
export async function issueConstancia(contractId: string): Promise<Constancia> {
  const response = await api.post<{ constancia: ConstanciaResponse }>(
    `/api/contracts/${contractId}/constancia`,
    {},
  );

  return toConstancia(response.constancia);
}

/** Verify one from the code printed on it. */
export async function lookupConstancia(code: string): Promise<Constancia> {
  const response = await api.get<{ constancia: ConstanciaResponse }>(
    `/api/constancias/lookup/${encodeURIComponent(code.trim())}`,
  );

  return toConstancia(response.constancia);
}
