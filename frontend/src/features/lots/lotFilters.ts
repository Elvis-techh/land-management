import type { Cents } from "../../lib/money";
import type { Lot, LotStatus } from "../../types";
import { lotStatus } from "./lotStatus";

/**
 * Everything the Lotes list can be narrowed by.
 *
 * `null` and the empty array both mean "no restriction", so an untouched filter
 * never has to be spelled out. Ranges are half-open on purpose: a minimum with
 * no maximum ("anything above 200,000") is the common case.
 */
export interface LotFilters {
  /**
   * Empty means every status.
   *
   * A list rather than one value, so "disponibles y reservados" — everything
   * not yet sold — can be asked for in one go. It also lets status combine with
   * a project instead of competing with it, which a single row of chips could
   * never do.
   */
  statuses: LotStatus[];
  /** Empty means every project. */
  projects: string[];
  minPrice: Cents | null;
  maxPrice: Cents | null;
  /** Always stored square metres, whatever unit the user typed them in. */
  minAreaM2: number | null;
  maxAreaM2: number | null;
}

export const NO_FILTERS: LotFilters = {
  statuses: [],
  projects: [],
  minPrice: null,
  maxPrice: null,
  minAreaM2: null,
  maxAreaM2: null,
};

/** How many restrictions are active — the number on the Filtros button. */
export function countActiveFilters(filters: LotFilters): number {
  let count = 0;

  if (filters.statuses.length > 0) {
    count += 1;
  }
  if (filters.projects.length > 0) {
    count += 1;
  }
  // A price range is one restriction whether the user set one end or both.
  if (filters.minPrice !== null || filters.maxPrice !== null) {
    count += 1;
  }
  if (filters.minAreaM2 !== null || filters.maxAreaM2 !== null) {
    count += 1;
  }

  return count;
}

export function hasActiveFilters(filters: LotFilters): boolean {
  return countActiveFilters(filters) > 0;
}

export function matchesFilters(lot: Lot, filters: LotFilters): boolean {
  if (filters.statuses.length > 0 && !filters.statuses.includes(lotStatus(lot))) {
    return false;
  }

  if (filters.projects.length > 0 && !filters.projects.includes(lot.projectName)) {
    return false;
  }

  if (filters.minPrice !== null && lot.basePrice < filters.minPrice) {
    return false;
  }

  if (filters.maxPrice !== null && lot.basePrice > filters.maxPrice) {
    return false;
  }

  if (filters.minAreaM2 !== null && lot.areaM2 < filters.minAreaM2) {
    return false;
  }

  if (filters.maxAreaM2 !== null && lot.areaM2 > filters.maxAreaM2) {
    return false;
  }

  return true;
}

export function filterLots(lots: Lot[], filters: LotFilters): Lot[] {
  return lots.filter((lot) => matchesFilters(lot, filters));
}
