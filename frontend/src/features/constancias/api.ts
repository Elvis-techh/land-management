import { api } from "../../lib/api";
import type { Cents } from "../../lib/money";
import { cents } from "../../lib/money";

/** One contract's part of a constancia: its lot, its value, and every payment that counts. */
export interface ConstanciaPart {
  contract: { id: string; code: string; salePrice: Cents; signedOn: string | null };
  lot: { code: string; projectName: string };
  payments: Array<{ paidOn: string; type: string; amount: Cents; receiptCode: string | null }>;
  totalPaid: Cents;
  lastPaidOn: string | null;
}

/**
 * A «Constancia de Cancelación Total», as the document needs it: for one
 * contract, or combined for several of the same customer's. Every figure is
 * read from the contracts' payments by the server; see
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
  /** Set once a contract on it stopped being paid off. The paper is then ANULADA. */
  voidedAt: string | null;
  voidReason: string | null;
  /** `phone` is not printed: it is where «Enviar por WhatsApp» sends it. */
  customer: { fullName: string; identification: string | null; phone: string | null };
  /** In lot order. One for an ordinary constancia, several for a combined one. */
  parts: ConstanciaPart[];
  /** The contracts' values, added up. */
  salePrice: Cents;
  totalPaid: Cents;
  lastPaidOn: string | null;
}

/** A paid-off contract that could go on a constancia. */
export interface CertifiableContract {
  contractId: string;
  contractCode: string;
  lotCode: string;
  projectName: string;
}

interface PartResponse extends Omit<ConstanciaPart, "contract" | "payments" | "totalPaid"> {
  contract: { id: string; code: string; salePriceCents: number; signedOn: string | null };
  payments: Array<{ paidOn: string; type: string; amountCents: number; receiptCode: string | null }>;
  totalPaidCents: number;
}

interface ConstanciaResponse
  extends Omit<Constancia, "parts" | "salePrice" | "totalPaid"> {
  parts: PartResponse[];
  salePriceCents: number;
  totalPaidCents: number;
}

/** Money is branded at this boundary, as everywhere else. */
function toPart({ contract, payments, totalPaidCents, ...rest }: PartResponse): ConstanciaPart {
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

function toConstancia({ parts, salePriceCents, totalPaidCents, ...rest }: ConstanciaResponse): Constancia {
  return {
    ...rest,
    parts: parts.map(toPart),
    salePrice: cents(salePriceCents),
    totalPaid: cents(totalPaidCents),
  };
}

/**
 * For the Constancia dialog of one contract: the customer's paid-off contracts
 * that could share a constancia with it (this one included), and every
 * standing constancia that already covers it.
 */
export async function fetchContractConstancias(
  contractId: string,
): Promise<{ eligible: CertifiableContract[]; standing: Constancia[] }> {
  const response = await api.get<{ eligible: CertifiableContract[]; standing: ConstanciaResponse[] }>(
    `/api/contracts/${contractId}/constancias`,
  );

  return { eligible: response.eligible, standing: response.standing.map(toConstancia) };
}

/** Issue one for these contracts — or get back the one already standing for exactly them. */
export async function issueConstancia(contractIds: string[]): Promise<Constancia> {
  const response = await api.post<{ constancia: ConstanciaResponse }>("/api/constancias", {
    contractIds,
  });

  return toConstancia(response.constancia);
}

/** Verify one from the code printed on it. */
export async function lookupConstancia(code: string): Promise<Constancia> {
  const response = await api.get<{ constancia: ConstanciaResponse }>(
    `/api/constancias/lookup/${encodeURIComponent(code.trim())}`,
  );

  return toConstancia(response.constancia);
}

/** Does this constancia speak for exactly these contracts? */
export function coversExactly(constancia: Constancia, contractIds: ReadonlySet<string>): boolean {
  return (
    constancia.parts.length === contractIds.size &&
    constancia.parts.every((part) => contractIds.has(part.contract.id))
  );
}
