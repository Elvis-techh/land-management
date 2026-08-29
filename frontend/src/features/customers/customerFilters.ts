import type { CustomerRecord } from "../../types";

/**
 * What a customer is currently holding, as the Clientes filter asks about it.
 *
 * The same three-way split the Lotes screen makes, read from the other end: a
 * lot is reserved or sold, so the person on it holds a reservation or a
 * contract. "none" is the customer nobody has put on anything — a lead, or
 * somebody whose contract has already ended.
 */
export type HoldingFilter = "contract" | "reservation" | "none";

/**
 * Everything the Clientes list can be narrowed by.
 *
 * `null` and the empty array both mean "no restriction", exactly as in
 * `LotFilters`, so an untouched filter never has to be spelled out. The search
 * box is deliberately NOT in here: it is visible on screen with its text in it,
 * so it does not need a chip to remind anybody it is on.
 */
export interface CustomerFilters {
  /**
   * Empty means everyone.
   *
   * A list rather than one value, so "los que tienen reserva o contrato" is one
   * question, and so a holding can be combined with a project instead of
   * competing with it.
   */
  holdings: HoldingFilter[];
  /** Empty means every project. Matches against ACTIVE contracts only. */
  projects: string[];
  /** Year range on "cliente desde". Half-open on purpose. */
  sinceFrom: number | null;
  sinceTo: number | null;
}

export const NO_CUSTOMER_FILTERS: CustomerFilters = {
  holdings: [],
  projects: [],
  sinceFrom: null,
  sinceTo: null,
};

/** How many restrictions are active — the number on the Filtros button. */
export function countActiveFilters(filters: CustomerFilters): number {
  let count = 0;

  if (filters.holdings.length > 0) {
    count += 1;
  }
  if (filters.projects.length > 0) {
    count += 1;
  }
  // A year range is one restriction whether the user set one end or both.
  if (filters.sinceFrom !== null || filters.sinceTo !== null) {
    count += 1;
  }

  return count;
}

export function hasActiveFilters(filters: CustomerFilters): boolean {
  return countActiveFilters(filters) > 0;
}

/** Does this customer hold anything of this kind right now? */
function matchesHolding(customer: CustomerRecord, holding: HoldingFilter): boolean {
  if (holding === "none") {
    return customer.contracts.length === 0;
  }

  return customer.contracts.some((contract) => contract.kind === holding);
}

export function matchesFilters(customer: CustomerRecord, filters: CustomerFilters): boolean {
  if (
    filters.holdings.length > 0 &&
    !filters.holdings.some((holding) => matchesHolding(customer, holding))
  ) {
    return false;
  }

  if (
    filters.projects.length > 0 &&
    !customer.contracts.some((contract) => filters.projects.includes(contract.projectName))
  ) {
    return false;
  }

  if (filters.sinceFrom !== null && customer.customerSince < filters.sinceFrom) {
    return false;
  }

  if (filters.sinceTo !== null && customer.customerSince > filters.sinceTo) {
    return false;
  }

  return true;
}

export function filterCustomers(
  customers: CustomerRecord[],
  filters: CustomerFilters,
): CustomerRecord[] {
  return customers.filter((customer) => matchesFilters(customer, filters));
}
