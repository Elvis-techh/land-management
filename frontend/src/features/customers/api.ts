import { api } from "../../lib/api";
import { cents } from "../../lib/money";
import type { CustomerRecord } from "../../types";

/** Exactly what GET /api/customers sends back. Money arrives as whole centavos. */
interface CustomersResponse {
  customers: Array<{
    id: string;
    fullName: string;
    identification: string | null;
    phone: string;
    email: string | null;
    address: string | null;
    customerSince: number;
    notes: string | null;
    contracts: Array<{
      contractId: string;
      contractCode: string;
      kind: "reservation" | "contract";
      lotCode: string;
      projectName: string;
      salePrice: number;
      paidToDate: number;
    }>;
  }>;
}

/**
 * Fetch the customers and brand every money field as `Cents`.
 *
 * The branding happens here, at the boundary, exactly as it does for lots: JSON
 * has no way to say "this number is centavos", so past this point TypeScript
 * will not let a plain number be used where money is expected.
 */
export async function fetchCustomers(): Promise<CustomerRecord[]> {
  const response = await api.get<CustomersResponse>("/api/customers");

  return response.customers.map((customer) => ({
    ...customer,
    contracts: customer.contracts.map((contract) => ({
      ...contract,
      salePrice: cents(contract.salePrice),
      paidToDate: cents(contract.paidToDate),
    })),
  }));
}

/**
 * What the form sends. The phone travels as the user typed it and is normalised
 * to E.164 by the server — see backend/src/lib/phone.ts.
 */
export interface CustomerDraft {
  fullName: string;
  /** Empty when the customer has not given one; the server stores that as NULL. */
  identification: string;
  phone: string;
  email: string | null;
  address: string | null;
  customerSince: number;
  notes: string | null;
}

export function createCustomer(draft: CustomerDraft) {
  return api.post<{ customer: { id: string; fullName: string } }>("/api/customers", draft);
}

export function updateCustomer(customerId: string, draft: CustomerDraft) {
  return api.patch<{ customer: { id: string; fullName: string } }>(
    `/api/customers/${customerId}`,
    draft,
  );
}

/**
 * Delete a customer for good.
 *
 * Rejects with the server's own wording when the person still has contracts —
 * see the guard in backend/src/routes/customers.ts. The reason is stored in the
 * audit history, which after this call is the only place the record survives.
 */
export function deleteCustomer(customerId: string, reason: string) {
  return api.delete<{ ok: true }>(`/api/customers/${customerId}`, { reason });
}
