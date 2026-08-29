import type { CustomerRecord } from "../../types";

/** The columns worth ordering by. Each maps to something visible in the table. */
export type SortField = "name" | "since" | "contracts";

export type SortDirection = "asc" | "desc";

export interface CustomerSort {
  field: SortField;
  direction: SortDirection;
}

/** Alphabetical, which is how the server already sends the list. */
export const DEFAULT_SORT: CustomerSort = { field: "name", direction: "asc" };

/**
 * How each option reads, and what its two directions are called.
 *
 * As in `lotSort.ts`, the wording follows the data: "A → Z" means nothing for a
 * year, and "más antiguos" means nothing for a name.
 */
export const SORT_OPTIONS: Array<{
  field: SortField;
  label: string;
  ascLabel: string;
  descLabel: string;
}> = [
  { field: "name", label: "Cliente", ascLabel: "A → Z", descLabel: "Z → A" },
  {
    field: "since",
    label: "Cliente desde",
    ascLabel: "Más antiguos primero",
    descLabel: "Más recientes primero",
  },
  {
    field: "contracts",
    label: "Contratos activos",
    ascLabel: "Menos a más",
    descLabel: "Más a menos",
  },
];

/**
 * Order the customers.
 *
 * "Contratos" counts the ACTIVE contracts the server sent, which is the number
 * printed in that column — sorting by anything else would order the table by a
 * figure nobody can see. A customer with none is a real zero, not a blank, so
 * unlike the lots table there is nothing to sink to the bottom.
 *
 * Every comparison falls back to the name, so customers who tie — the same
 * year, the same number of contracts — keep a stable order instead of shuffling
 * between renders.
 */
export function sortCustomers(
  customers: CustomerRecord[],
  sort: CustomerSort,
): CustomerRecord[] {
  const byName = (a: CustomerRecord, b: CustomerRecord) =>
    a.fullName.localeCompare(b.fullName, "es");

  const compare = (a: CustomerRecord, b: CustomerRecord): number => {
    switch (sort.field) {
      case "since":
        return a.customerSince - b.customerSince;
      case "contracts":
        return a.contracts.length - b.contracts.length;
      case "name":
      default:
        return byName(a, b);
    }
  };

  const factor = sort.direction === "asc" ? 1 : -1;

  // A copy: sorting the array we were handed would mutate the caller's state.
  return [...customers].sort((a, b) => {
    const result = compare(a, b);

    if (result !== 0) {
      return result * factor;
    }

    // The tiebreaker is NOT flipped by direction, so reversing the sort does
    // not also reverse groups of equal rows for no visible reason.
    return byName(a, b);
  });
}
