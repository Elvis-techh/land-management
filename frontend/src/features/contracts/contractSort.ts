import type { Cents } from "../../lib/money";
import { cents } from "../../lib/money";
import type { Contract } from "../../types";

export type SortField = "customer" | "balance" | "health" | "nextDue" | "code";

export interface ContractSort {
  field: SortField;
  direction: "asc" | "desc";
}

/**
 * Sorted by whoever needs attention first, not alphabetically.
 *
 * The default a receivables screen should open on is the customer furthest
 * behind. Somebody opening Contratos on a Monday morning is looking for who to
 * call, and making them sort for that every time is making the screen answer
 * the wrong question by default.
 */
export const DEFAULT_SORT: ContractSort = { field: "health", direction: "desc" };

export const SORT_OPTIONS: Array<{
  field: SortField;
  label: string;
  ascLabel: string;
  descLabel: string;
}> = [
  { field: "health", label: "Estado de pago", ascLabel: "al día primero", descLabel: "atrasados primero" },
  { field: "customer", label: "Cliente", ascLabel: "A → Z", descLabel: "Z → A" },
  { field: "balance", label: "Saldo", ascLabel: "menor primero", descLabel: "mayor primero" },
  { field: "nextDue", label: "Próxima cuota", ascLabel: "más próxima", descLabel: "más lejana" },
  { field: "code", label: "Número", ascLabel: "más antiguo", descLabel: "más reciente" },
];

/** Worst first when sorting descending, so the severity order is explicit. */
const HEALTH_SEVERITY: Record<Contract["health"]["status"], number> = {
  current: 0,
  due_soon: 1,
  overdue: 2,
  at_risk: 3,
};

function compare(a: Contract, b: Contract, field: SortField): number {
  switch (field) {
    case "customer":
      return a.customer.fullName.localeCompare(b.customer.fullName, "es");
    case "balance":
      return a.balance - b.balance;
    case "health":
      return HEALTH_SEVERITY[a.health.status] - HEALTH_SEVERITY[b.health.status];
    case "nextDue":
      // A contract with nothing left to pay has no next due date. It sorts last
      // either way rather than jumping to the top as an empty string would.
      return (a.health.nextDueOn ?? "9999-12-31").localeCompare(b.health.nextDueOn ?? "9999-12-31");
    case "code":
      return a.code.localeCompare(b.code, "es");
  }
}

export function sortContracts(contracts: Contract[], sort: ContractSort): Contract[] {
  const direction = sort.direction === "asc" ? 1 : -1;

  return [...contracts].sort((a, b) => {
    const primary = compare(a, b, sort.field) * direction;

    if (primary !== 0) {
      return primary;
    }

    // A stable tie-break, so rows never shuffle between renders. The customer
    // name keeps a person's contracts adjacent, which is what the grouping
    // below depends on.
    return (
      a.customer.fullName.localeCompare(b.customer.fullName, "es") ||
      a.code.localeCompare(b.code, "es")
    );
  });
}

/**
 * One customer's contracts, kept together.
 *
 * The table's row is still the CONTRACT — that is where the money lives — but a
 * customer with three lots is one person to call, one conversation and one
 * receipt, so their rows are collected under a header carrying the totals.
 *
 * Order is taken from the sorted list: a group sits wherever its first contract
 * landed, so sorting by "atrasados primero" still puts the worst customer at
 * the top rather than quietly reverting to alphabetical.
 */
export interface ContractGroup {
  customerId: string;
  customerName: string;
  contracts: Contract[];
  /** Summed across the group — the figure the customer actually recognises. */
  totalBalance: Cents;
  totalMonthly: Cents;
  /** The whole purchase, for the group header's Precio and Prima columns. */
  totalPrice: Cents;
  totalDownPayment: Cents;
  /** The worst health in the group: one lot behind means the customer is behind. */
  worst: Contract;
  /** True when these lots were bought as ONE purchase, not just by one person. */
  isOnePurchase: boolean;
}

export function groupByCustomer(contracts: Contract[]): ContractGroup[] {
  const groups = new Map<string, Contract[]>();

  for (const contract of contracts) {
    const existing = groups.get(contract.customer.id);

    if (existing) {
      existing.push(contract);
    } else {
      groups.set(contract.customer.id, [contract]);
    }
  }

  return [...groups.entries()].map(([customerId, list]) => {
    const first = list[0]!;
    const saleGroupIds = new Set(list.map((contract) => contract.saleGroupId));

    return {
      customerId,
      customerName: first.customer.fullName,
      contracts: list,
      // Re-branded through `cents()` rather than left as a bare sum: adding
      // two `Cents` gives a plain number back, and money that has lost its
      // brand is money that can be passed somewhere expecting lempiras.
      totalBalance: cents(list.reduce((sum, contract) => sum + contract.balance, 0)),
      totalMonthly: cents(
        list.reduce((sum, contract) => sum + (contract.terms.monthlyPayment ?? 0), 0),
      ),
      totalPrice: cents(list.reduce((sum, contract) => sum + contract.terms.salePrice, 0)),
      totalDownPayment: cents(
        list.reduce((sum, contract) => sum + contract.terms.downPayment, 0),
      ),
      worst: list.reduce((worst, contract) =>
        HEALTH_SEVERITY[contract.health.status] > HEALTH_SEVERITY[worst.health.status]
          ? contract
          : worst,
      ),
      // Every lot on the same sale group id, and that id is not null: one
      // signature, one payment, one receipt. Two lots bought years apart are
      // the same person but not the same purchase, and the split must not
      // treat them as one.
      isOnePurchase: saleGroupIds.size === 1 && first.saleGroupId !== null,
    };
  });
}
