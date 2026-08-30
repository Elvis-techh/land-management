import type { Transaction } from "../../types";

/** The columns worth ordering by. Each maps to something visible in the list. */
export type SortField = "date" | "customer" | "amount" | "lot";

export type SortDirection = "asc" | "desc";

export interface TransactionSort {
  field: SortField;
  direction: SortDirection;
}

/**
 * Newest first, which is what a transactions screen is for.
 *
 * Somebody opening this tab is nearly always looking for something that
 * happened today or yesterday, not for the first payment ever taken.
 */
export const DEFAULT_SORT: TransactionSort = { field: "date", direction: "desc" };

/**
 * How each option reads, and what its two directions are called.
 *
 * The wording follows the data, as in `customerSort.ts`: "A → Z" means nothing
 * for an amount, and "más recientes" means nothing for a name.
 */
export const SORT_OPTIONS: Array<{
  field: SortField;
  label: string;
  ascLabel: string;
  descLabel: string;
}> = [
  {
    field: "date",
    label: "Fecha del pago",
    ascLabel: "Más antiguos primero",
    descLabel: "Más recientes primero",
  },
  { field: "customer", label: "Cliente", ascLabel: "A → Z", descLabel: "Z → A" },
  { field: "amount", label: "Monto", ascLabel: "Menor a mayor", descLabel: "Mayor a menor" },
  { field: "lot", label: "Lote", ascLabel: "A → Z", descLabel: "Z → A" },
];

/**
 * Order the transactions.
 *
 * Every comparison falls back to the date and then the id, so rows that tie —
 * two payments from the same customer on the same day — keep a stable order
 * instead of shuffling between renders. The fallback is NOT flipped by
 * direction: reversing the sort should not also reverse groups of equal rows
 * for no visible reason.
 */
export function sortTransactions(
  transactions: Transaction[],
  sort: TransactionSort,
): Transaction[] {
  const stable = (a: Transaction, b: Transaction) =>
    b.paidOn.localeCompare(a.paidOn) || a.id.localeCompare(b.id);

  const compare = (a: Transaction, b: Transaction): number => {
    switch (sort.field) {
      case "customer":
        return a.customerName.localeCompare(b.customerName, "es");
      case "amount":
        return a.amount - b.amount;
      case "lot":
        return a.lotCode.localeCompare(b.lotCode, "es");
      case "date":
      default:
        // Ascending means oldest first, so the raw comparison is a plain one.
        return a.paidOn.localeCompare(b.paidOn);
    }
  };

  const factor = sort.direction === "asc" ? 1 : -1;

  // A copy: sorting the array we were handed would mutate the caller's state.
  return [...transactions].sort((a, b) => {
    const result = compare(a, b);

    return result !== 0 ? result * factor : stable(a, b);
  });
}

/**
 * The customers who have at least one transaction, each with theirs.
 *
 * Built from the same array the flat list uses, so the two views can never
 * disagree about what exists. Customers with no payments simply do not appear —
 * this is a list of money that moved, not a directory of people.
 */
export interface CustomerGroup {
  customerId: string;
  customerName: string;
  customerIdentification: string;
  transactions: Transaction[];
  /** Non-reversed only: what this person has actually paid. */
  totalCents: number;
  /** The most recent payment, for the collapsed summary line. */
  lastPaidOn: string;
}

export function groupByCustomer(
  transactions: Transaction[],
  sort: TransactionSort,
): CustomerGroup[] {
  const groups = new Map<string, CustomerGroup>();

  for (const transaction of transactions) {
    const existing = groups.get(transaction.customerId);

    if (existing) {
      existing.transactions.push(transaction);
    } else {
      groups.set(transaction.customerId, {
        customerId: transaction.customerId,
        customerName: transaction.customerName,
        customerIdentification: transaction.customerIdentification,
        transactions: [transaction],
        totalCents: 0,
        lastPaidOn: transaction.paidOn,
      });
    }
  }

  for (const group of groups.values()) {
    // Inside a customer, the chosen sort still applies — somebody who opened
    // "mayor a menor" expects it to hold within the person they expand.
    group.transactions = sortTransactions(group.transactions, sort);

    group.totalCents = group.transactions
      .filter((transaction) => transaction.reversedAt === null)
      .reduce((sum, transaction) => sum + transaction.amount, 0);

    group.lastPaidOn = group.transactions.reduce(
      (latest, transaction) => (transaction.paidOn > latest ? transaction.paidOn : latest),
      group.transactions[0]?.paidOn ?? "",
    );
  }

  const ordered = [...groups.values()];

  // The GROUPS are ordered by the same choice where it makes sense. Sorting
  // people by "lote" is meaningless, so those fall back to the most recent
  // payment — which is the useful answer when the question is about a person.
  const factor = sort.direction === "asc" ? 1 : -1;

  ordered.sort((a, b) => {
    switch (sort.field) {
      case "customer":
        return a.customerName.localeCompare(b.customerName, "es") * factor;
      case "amount":
        return (a.totalCents - b.totalCents) * factor;
      case "date":
      case "lot":
      default:
        return a.lastPaidOn.localeCompare(b.lastPaidOn) * factor;
    }
  });

  return ordered;
}
