import { parseTimestamp } from "../../lib/time";
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
 * When a transaction happened, to the finest resolution the data has.
 *
 * `paidOn` is a calendar DATE, so three payments taken on 30 August all tie on
 * it — and a tie is not a detail here, it is most of the screen: a busy day is
 * exactly when several payments share a date. `createdAt` breaks the tie with
 * the order they were entered.
 *
 * This is the first two parts of the three-part key `backend/src/lib/ledger.ts`
 * orders a contract's ledger by, and it is deliberately the same one. A list
 * that disagrees with the ledger about which of two payments came first is a
 * list that disagrees with the receipts printed from it.
 */
function compareWhen(a: Transaction, b: Transaction): number {
  return (
    a.paidOn.localeCompare(b.paidOn) ||
    parseTimestamp(a.createdAt) - parseTimestamp(b.createdAt)
  );
}

/**
 * LEDGER ORDER: `paidOn`, then `createdAt`, then the id. Oldest first.
 *
 * The whole key, and the same three parts in the same order as
 * `compareLedgerOrder` in backend/src/lib/ledger.ts. Exported because the
 * correction dialog's history has to be this exact sequence — it is the order
 * the server replays a contract in, so it is the order the balances either side
 * of an edit were derived from.
 *
 * The id is arbitrary — a `randomUUID()` — and only ever settles a genuine dead
 * heat. Two payments tie that far when they share a `paidOn` AND a `createdAt`
 * to the millisecond, which is not an exotic case: a receipt covering three
 * lots writes three payments inside one database transaction, all stamped from
 * the same `new Date()`. What the id buys is not meaning, it is TOTALITY — a
 * comparison that never returns zero, so there is exactly one order and every
 * screen reads the same one.
 */
export function compareLedgerOrder(a: Transaction, b: Transaction): number {
  return compareWhen(a, b) || a.id.localeCompare(b.id);
}

/**
 * Order the transactions.
 *
 * Ordering by "Fecha del pago" is ledger order, whole, with the direction
 * applied to ALL THREE parts of the key — so "más recientes primero" is the
 * exact reverse of "más antiguos primero", and of the history in the correction
 * dialog. That is a stronger promise than it sounds, and it is the one that was
 * broken:
 *
 * The list used to reverse `paidOn` and `createdAt` but leave the final id
 * comparison ascending. Rows that tie on the first two parts therefore came out
 * in the SAME relative order whichever direction was chosen — and a receipt
 * covering three lots produces exactly such a tie, three payments stamped from
 * one `new Date()`. So the bottom row of a newest-first list was the LAST of
 * those three, while the oldest-first history put it third. Scroll to the foot
 * of a customer's payments, open the one that has to be their first, and the
 * dialog highlighted the third. Nothing was miscounted; the two screens were
 * reading one ambiguity in two directions.
 *
 * Ordering by anything else keeps a different rule, deliberately. Rows the
 * chosen field cannot separate fall back to ledger order REVERSED — newest
 * first — and that fallback is not flipped by direction: asking for "menor a
 * mayor" should not also reverse the two payments that tie at L 5,000, for no
 * visible reason.
 */
export function sortTransactions(
  transactions: Transaction[],
  sort: TransactionSort,
): Transaction[] {
  const factor = sort.direction === "asc" ? 1 : -1;

  // A copy: sorting the array we were handed would mutate the caller's state.
  if (sort.field === "date") {
    return [...transactions].sort((a, b) => compareLedgerOrder(a, b) * factor);
  }

  const compare = (a: Transaction, b: Transaction): number => {
    switch (sort.field) {
      case "customer":
        return a.customerName.localeCompare(b.customerName, "es");
      case "amount":
        return a.amount - b.amount;
      case "lot":
      default:
        return a.lotCode.localeCompare(b.lotCode, "es");
    }
  };

  return [...transactions].sort(
    (a, b) => compare(a, b) * factor || -compareLedgerOrder(a, b),
  );
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
    const result = (() => {
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
    })();

    // Two people whose last payment fell on the same day, or who have paid the
    // same total, are separated by name rather than by whichever the server
    // listed first. Same reason as the flat list: an order nobody can explain
    // reads as an order that means something.
    return (
      result ||
      a.customerName.localeCompare(b.customerName, "es") ||
      a.customerId.localeCompare(b.customerId)
    );
  });

  return ordered;
}
