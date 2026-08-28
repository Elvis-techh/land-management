import type { Customer, Lot } from "../../types";
import { lotStatus } from "./lotStatus";
import { parseLotCode } from "./lotCode";

/** The columns worth ordering by. Each maps to a column in the table. */
export type SortField = "code" | "project" | "area" | "price" | "status" | "customer";

export type SortDirection = "asc" | "desc";

export interface LotSort {
  field: SortField;
  direction: SortDirection;
}

export const DEFAULT_SORT: LotSort = { field: "code", direction: "asc" };

/**
 * How each option reads, and what its two directions are called.
 *
 * "A → Z" means nothing for a price, and "menor a mayor" means nothing for a
 * name, so the wording follows the data rather than being one generic pair
 * reused everywhere.
 */
export const SORT_OPTIONS: Array<{
  field: SortField;
  label: string;
  ascLabel: string;
  descLabel: string;
}> = [
  { field: "code", label: "Lote", ascLabel: "A → Z", descLabel: "Z → A" },
  { field: "project", label: "Proyecto", ascLabel: "A → Z", descLabel: "Z → A" },
  { field: "area", label: "Área", ascLabel: "Menor a mayor", descLabel: "Mayor a menor" },
  { field: "price", label: "Precio base", ascLabel: "Menor a mayor", descLabel: "Mayor a menor" },
  { field: "status", label: "Estado", ascLabel: "Disponibles primero", descLabel: "Vendidos primero" },
  { field: "customer", label: "Cliente", ascLabel: "A → Z", descLabel: "Z → A" },
];

/** Disponible → Reservado → Vendido: the order the inventory moves through. */
const STATUS_ORDER = { available: 0, reserved: 1, sold: 2 } as const;

/**
 * Compare two lot codes the way a person reads them.
 *
 * Plain text sorting puts "A-10" before "A-2", because it compares "1" against
 * "2" one character at a time. Splitting the code into its letters and its
 * number — the same split the new-lot form makes — sorts A-2 before A-10, which
 * is the only order anybody expects from a list of lots.
 *
 * Codes that do not fit that shape (a manually typed ID) fall back to plain
 * text comparison and sort after the structured ones, so they stay together
 * instead of scattering through the list.
 */
export function compareLotCodes(a: string, b: string): number {
  const left = parseLotCode(a);
  const right = parseLotCode(b);

  if (left && right) {
    return left.prefix.localeCompare(right.prefix, "es") || left.number - right.number;
  }

  if (left) {
    return -1;
  }
  if (right) {
    return 1;
  }

  return a.localeCompare(b, "es");
}

/**
 * Order the lots.
 *
 * Area always compares STORED square metres, never the number on screen. Two
 * projects can be written in different units, and sorting 1.5 mz above 400 m²
 * because 400 is the bigger numeral would be nonsense.
 *
 * Every comparison falls back to the lot code, so lots that tie — the same
 * price, the same project — keep a stable, predictable order instead of
 * shuffling between renders.
 */
export function sortLots(
  lots: Lot[],
  sort: LotSort,
  customersById: Map<string, Customer>,
): Lot[] {
  const holderName = (lot: Lot) =>
    lot.holding ? (customersById.get(lot.holding.customerId)?.fullName ?? "") : "";

  const compare = (a: Lot, b: Lot): number => {
    switch (sort.field) {
      case "project":
        return a.projectName.localeCompare(b.projectName, "es");
      case "area":
        return a.areaM2 - b.areaM2;
      case "price":
        return a.basePrice - b.basePrice;
      case "status":
        return STATUS_ORDER[lotStatus(a)] - STATUS_ORDER[lotStatus(b)];
      case "customer":
        // Both sides are known to be non-empty here: blanks were separated out
        // before this runs, so they cannot sort as "the smallest name".
        return holderName(a).localeCompare(holderName(b), "es");
      case "code":
      default:
        return compareLotCodes(a.code, b.code);
    }
  };

  const factor = sort.direction === "asc" ? 1 : -1;

  /**
   * A lot with nobody on it has nothing to compare when sorting by client.
   *
   * Blanks sink to the bottom in BOTH directions — the behaviour of every
   * spreadsheet people have used. Leaving them to the ordinary comparison would
   * send them to the top on a descending sort, so that "Cliente Z → A" opens on
   * a screen full of empty cells.
   */
  const isBlank = (lot: Lot) => sort.field === "customer" && holderName(lot) === "";

  // A copy: sorting the array we were handed would mutate the caller's state.
  return [...lots].sort((a, b) => {
    if (isBlank(a) !== isBlank(b)) {
      return isBlank(a) ? 1 : -1;
    }

    const result = isBlank(a) ? 0 : compare(a, b);

    if (result !== 0) {
      return result * factor;
    }

    // The tiebreaker is NOT flipped by direction, so reversing the sort does
    // not also reverse groups of equal rows for no visible reason.
    return compareLotCodes(a.code, b.code);
  });
}
