import type { Contract, ContractStatus, PaymentHealth, SaleType } from "../../types";
import { formatPhone } from "../../lib/phone";

/**
 * Everything the Contratos list can be narrowed by.
 *
 * An empty array means "no restriction", exactly as in `LotFilters` and
 * `CustomerFilters`, so an untouched filter never has to be spelled out.
 *
 * `statuses` is the one filter that starts with something in it. A cancelled
 * contract stays in the table forever — nothing financial is ever deleted — so
 * within a year the working list would be mostly history if the default were
 * "everything". Defaulting to vigentes is what keeps this screen about the
 * money that is still moving, and the chip says so out loud.
 */
export interface ContractFilters {
  statuses: ContractStatus[];
  health: PaymentHealth[];
  saleTypes: SaleType[];
  kinds: Array<Contract["kind"]>;
  projects: string[];
  /** Hide contracts that owe nothing, so the list is only live receivables. */
  onlyWithBalance: boolean;
}

export const DEFAULT_CONTRACT_FILTERS: ContractFilters = {
  statuses: ["active"],
  health: [],
  saleTypes: [],
  kinds: [],
  projects: [],
  onlyWithBalance: false,
};

/** Everything off — what "Limpiar filtros" actually clears to. */
export const NO_CONTRACT_FILTERS: ContractFilters = {
  statuses: [],
  health: [],
  saleTypes: [],
  kinds: [],
  projects: [],
  onlyWithBalance: false,
};

/**
 * A filter state somewhere else can ask the Contratos tab to open with.
 *
 * Deliberately a partial rather than a whole `ContractFilters`: a caller wants
 * to say "the overdue ones" and should not have to restate the four filters it
 * has no opinion about, nor be silently broken when a fifth is added. Anything
 * left out keeps its default — including `statuses: ["active"]`, which is what
 * stops a drill-down from resurrecting cancelled contracts nobody asked for.
 */
export type ContractFilterPreset = Partial<ContractFilters>;

/** The default filters with a preset laid over the top. */
export function presetFilters(preset: ContractFilterPreset): ContractFilters {
  return { ...DEFAULT_CONTRACT_FILTERS, ...preset };
}

/** The health values that mean "behind" — the same split the server makes. */
export const BEHIND_HEALTH: PaymentHealth[] = ["overdue", "at_risk"];

export function countActiveFilters(filters: ContractFilters): number {
  let count = 0;

  for (const list of [
    filters.statuses,
    filters.health,
    filters.saleTypes,
    filters.kinds,
    filters.projects,
  ]) {
    if (list.length > 0) {
      count += 1;
    }
  }

  if (filters.onlyWithBalance) {
    count += 1;
  }

  return count;
}

export function hasActiveFilters(filters: ContractFilters): boolean {
  return countActiveFilters(filters) > 0;
}

export function matchesFilters(contract: Contract, filters: ContractFilters): boolean {
  if (filters.statuses.length > 0 && !filters.statuses.includes(contract.status)) {
    return false;
  }

  if (filters.health.length > 0) {
    // Payment health only means something for a contract that is still being
    // paid. A cancelled, defaulted or paid-off one carries a computed health
    // the server never stopped deriving — filtering "en riesgo" must not drag
    // a defaulted contract back into view.
    if (contract.status !== "active" || !filters.health.includes(contract.health.status)) {
      return false;
    }
  }

  if (filters.saleTypes.length > 0 && !filters.saleTypes.includes(contract.saleType)) {
    return false;
  }

  if (filters.kinds.length > 0 && !filters.kinds.includes(contract.kind)) {
    return false;
  }

  if (filters.projects.length > 0 && !filters.projects.includes(contract.lot.projectName)) {
    return false;
  }

  if (filters.onlyWithBalance && contract.balance <= 0) {
    return false;
  }

  return true;
}

export function filterContracts(
  contracts: Contract[],
  filters: ContractFilters,
): Contract[] {
  return contracts.filter((contract) => matchesFilters(contract, filters));
}

/**
 * Everything about a contract somebody might type into the search box.
 *
 * The contract number and the lot number are both in here because "¿quién es
 * CT-2026-014?" and "¿quién tiene el A-07?" are asked as often as the
 * customer's name, and all three should land on the same row.
 */
function haystack(contract: Contract): string {
  return [
    contract.code,
    contract.customer.fullName,
    formatPhone(contract.customer.phone),
    contract.lot.code,
    contract.lot.projectName,
    contract.notes ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

export function searchContracts(contracts: Contract[], search: string): Contract[] {
  const query = search.trim().toLowerCase();

  if (query === "") {
    return contracts;
  }

  // Every word has to match something, so "elena valle" narrows rather than
  // widening — how people expect a search box to behave.
  const words = query.split(/\s+/);

  return contracts.filter((contract) => {
    const text = haystack(contract);
    return words.every((word) => text.includes(word));
  });
}
