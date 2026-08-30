/**
 * The running balance of a contract, replayed from its transactions.
 *
 * This file exists to kill a specific class of bug — the one that makes a
 * spreadsheet unusable as a book of receipts.
 *
 * In a spreadsheet, "saldo anterior" and "saldo nuevo" are rollups, so they
 * always show TODAY's figures. Print a receipt in March and open it again in
 * May and it has quietly rewritten itself: the customer's paper and the screen
 * no longer agree, and there is no way to tell which is the lie. The usual fix
 * is to freeze the numbers into columns and lock the row — which trades the
 * first bug for a worse one, because a frozen number is stale the moment an old
 * payment is corrected, and nothing on the row admits it.
 *
 * Neither is necessary. A balance is not a fact that has to be stored; it is a
 * fact that has to be DERIVED, at a stated position in an ordered ledger:
 *
 *     saldo anterior = charges − credits posted strictly before this one
 *     saldo nuevo    = saldo anterior − this transaction
 *
 * Derive it and both problems vanish at once. Every receipt shows the numbers
 * that were true at its own position, permanently, with nothing to lock and
 * nothing to forget. And correcting a payment from two months ago — or the
 * prima from last year — re-derives every receipt after it into figures that
 * still add up, because they were never numbers in the first place. They were a
 * query.
 *
 * Nothing here reads or writes the database, so all of it is testable against
 * plain arrays.
 */

import { parseTimestamp } from "./time.js";

/* -------------------------------------------------------------------------- */
/* Ordering                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The minimum a row needs for the ledger to place it. A subset of the payments
 * row on purpose: it keeps the arithmetic testable without building a whole
 * database record, and makes it obvious that no other column can influence
 * where a transaction lands.
 */
export interface LedgerOrderable {
  id: string;
  /** YYYY-MM-DD. The date the money moved, not the row's insert time. */
  paidOn: string;
  /** ISO-8601 or SQLite's own format — `parseTimestamp` normalises both. */
  createdAt: string;
}

/**
 * The total order over one contract's transactions, and the single most
 * load-bearing decision in this file.
 *
 * "Previous balance" is meaningless without an answer to "previous to WHAT?",
 * and `paidOn` alone cannot give one: it is a calendar date, so two payments on
 * the same day tie, and a tie means two screens can disagree about which came
 * first — which is precisely the disagreement that makes a customer stop
 * trusting the receipts.
 *
 * So the key is three parts deep and the last one cannot tie:
 *
 *  1. `paidOn`   — the day the money actually moved. This is what makes a
 *                  payment entered late land in its real place in history
 *                  rather than at the end.
 *  2. `createdAt` — the order they were entered, for two payments on one day.
 *  3. `id`        — arbitrary, but STABLE, so the order never depends on which
 *                  row SQLite happened to return first.
 *
 * `createdAt` is compared as a parsed instant rather than as text. Rows written
 * by the application carry "2026-08-26T15:02:23.451Z" and rows written by a
 * column default carry SQLite's "2026-08-26 15:02:23"; comparing those as
 * strings sorts every space-form row before every T-form row on the same day,
 * because ' ' < 'T'. See src/lib/time.ts.
 */
export function compareLedgerOrder(a: LedgerOrderable, b: LedgerOrderable): number {
  if (a.paidOn !== b.paidOn) {
    return a.paidOn < b.paidOn ? -1 : 1;
  }

  const createdDelta = parseTimestamp(a.createdAt) - parseTimestamp(b.createdAt);

  if (createdDelta !== 0) {
    return createdDelta;
  }

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The same transactions, in ledger order. Does not mutate the input. */
export function orderLedger<T extends LedgerOrderable>(entries: readonly T[]): T[] {
  return [...entries].sort(compareLedgerOrder);
}

/* -------------------------------------------------------------------------- */
/* Charges and credits                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Something the customer OWES, beyond the agreed sale price.
 *
 * There are none today, and this list is empty everywhere in the current app —
 * so read this as a seam rather than as a feature.
 *
 * The seam is deliberate. Every balance in Lindero is currently
 * `salePrice − payments`, and that formula has exactly one more day of life in
 * it: the first late fee, the first legal fee for a repossession, the first
 * L 500 charged for a re-issued document, and it is wrong. Not slightly wrong —
 * wrong in the direction that makes a customer's balance disagree with what the
 * office says they owe.
 *
 * The general form, which this file computes today and will still compute then,
 * is:
 *
 *     balance = charges − credits
 *
 * where the sale price is simply the opening charge. Adding late fees later
 * therefore means adding rows to a `charges` table and passing them in here. It
 * does not mean revisiting the arithmetic in this file, the receipt figures, or
 * any screen that displays them. That is the entire reason the parameter exists
 * before anything populates it.
 */
export interface LedgerCharge {
  id: string;
  /** YYYY-MM-DD — the day it became owed, which is where it lands in the ledger. */
  incurredOn: string;
  amountCents: number;
  /** "late_fee" | "legal_fee" | "other" — the sale price is not one of these. */
  kind: string;
}

/** A transaction the customer is CREDITED for: a payment that still counts. */
export interface LedgerCredit extends LedgerOrderable {
  amountCents: number;
  /** Reversed transactions are excluded before they ever reach the ledger. */
  reversedAt?: string | null;
}

/**
 * A reversed payment stops counting, but is never deleted and never edited.
 *
 * Kept as its own named function because it is the rule the whole app agrees
 * on — the same `reversed_at IS NULL` that routes/lots.ts, routes/customers.ts
 * and routes/contracts.ts each apply in SQL.
 */
export function isCounted(credit: LedgerCredit): boolean {
  return !credit.reversedAt;
}

/* -------------------------------------------------------------------------- */
/* The replay                                                                  */
/* -------------------------------------------------------------------------- */

/** One transaction, with the balance either side of it. */
export interface LedgerLine<T extends LedgerCredit> {
  entry: T;
  /** What was owed immediately BEFORE this transaction. */
  balanceBeforeCents: number;
  /** What was owed immediately after. Never negative — see `replayContract`. */
  balanceAfterCents: number;
  /** Everything credited up to and including this transaction. */
  paidToDateCents: number;
  /** Charges that fell due between the previous transaction and this one. */
  chargesAppliedCents: number;
}

export interface ContractLedger<T extends LedgerCredit> {
  /** The sale price plus any additional charges. What was ever owed in total. */
  totalChargesCents: number;
  /** Everything credited, ever. */
  totalCreditedCents: number;
  /** `totalCharges − totalCredited`, floored at zero. */
  balanceCents: number;
  /** One line per counted transaction, in ledger order. */
  lines: LedgerLine<T>[];
  /**
   * Credited beyond what was owed. Returned rather than absorbed, exactly as
   * `splitEvenly` returns `unallocatedCents`: an overpayment silently swallowed
   * into a negative balance is a credit nobody can later explain.
   */
  overpaidCents: number;
}

export interface ReplayInput<T extends LedgerCredit> {
  /**
   * The agreed sale price, which opens the ledger.
   *
   * Applied FIRST, ahead of every dated charge and credit, rather than at its
   * own date. A deposit taken the week before signing would otherwise replay as
   * a credit against a balance of zero and report a "previous balance" of
   * nothing on the customer's very first receipt.
   */
  salePriceCents: number;
  /** Empty in the current app. See `LedgerCharge`. */
  charges?: readonly LedgerCharge[];
  /** Every payment on the contract. Reversed ones are filtered out here. */
  credits: readonly T[];
}

/**
 * Replay one contract's ledger from the beginning.
 *
 * O(n log n) in the number of transactions, run on demand. A contract has a few
 * dozen payments over its life, so replaying from zero on every read is
 * cheaper than the machinery it would take to cache it correctly — and cached
 * balances that fall out of step with their payments are the exact failure this
 * file exists to prevent.
 */
export function replayContract<T extends LedgerCredit>(input: ReplayInput<T>): ContractLedger<T> {
  const credits = orderLedger(input.credits.filter(isCounted));
  const charges = [...(input.charges ?? [])].sort((a, b) =>
    a.incurredOn === b.incurredOn ? (a.id < b.id ? -1 : 1) : a.incurredOn < b.incurredOn ? -1 : 1,
  );

  const lines: LedgerLine<T>[] = [];

  let chargedSoFar = input.salePriceCents;
  let creditedSoFar = 0;
  let nextCharge = 0;

  for (const entry of credits) {
    // Charges that fell due on or before this transaction's date are owed by
    // the time it is made, so they are inside the "saldo anterior" the customer
    // is shown — not added afterwards, which would print a receipt whose own
    // arithmetic does not work.
    let chargesApplied = 0;

    while (nextCharge < charges.length && charges[nextCharge]!.incurredOn <= entry.paidOn) {
      chargesApplied += charges[nextCharge]!.amountCents;
      nextCharge += 1;
    }

    chargedSoFar += chargesApplied;

    const balanceBeforeCents = Math.max(0, chargedSoFar - creditedSoFar);

    creditedSoFar += entry.amountCents;

    lines.push({
      entry,
      balanceBeforeCents,
      balanceAfterCents: Math.max(0, chargedSoFar - creditedSoFar),
      paidToDateCents: creditedSoFar,
      chargesAppliedCents: chargesApplied,
    });
  }

  // Anything dated after the last transaction still counts towards the total.
  for (let index = nextCharge; index < charges.length; index += 1) {
    chargedSoFar += charges[index]!.amountCents;
  }

  return {
    totalChargesCents: chargedSoFar,
    totalCreditedCents: creditedSoFar,
    balanceCents: Math.max(0, chargedSoFar - creditedSoFar),
    lines,
    overpaidCents: Math.max(0, creditedSoFar - chargedSoFar),
  };
}

/* -------------------------------------------------------------------------- */
/* What a receipt says                                                         */
/* -------------------------------------------------------------------------- */

/** One lot's line on a printed receipt. */
export interface ReceiptContractLine {
  contractId: string;
  paymentId: string;
  amountCents: number;
  /** The customer's balance on THIS contract before this receipt's payment. */
  balanceBeforeCents: number;
  balanceAfterCents: number;
}

/**
 * Everything the numbers on one receipt are, derived rather than remembered.
 *
 * These are the columns a spreadsheet has to freeze — previous balance, new
 * balance, cumulative paid. None of them is stored anywhere in Lindero.
 */
export interface ReceiptFigures {
  lines: ReceiptContractLine[];
  /** The amount on the face of the receipt: what the customer handed over. */
  totalPaidCents: number;
  /** Summed across the contracts this receipt touches, before it was applied. */
  previousBalanceCents: number;
  newBalanceCents: number;
  /**
   * Everything this customer has ever paid, across every contract, up to and
   * including this receipt.
   *
   * Customer-wide rather than per contract, because that is the figure somebody
   * actually asks for — "how much have I given you in total" is never a
   * question about one lot.
   */
  cumulativePaidCents: number;
}

export interface ReceiptFiguresInput<T extends LedgerCredit & { contractId: string }> {
  /** The ids of the payments printed on this receipt. */
  paymentIds: readonly string[];
  /** EVERY payment belonging to this customer, on every contract they hold. */
  customerCredits: readonly T[];
  /** Sale price per contract id. Contracts with no payment here may be omitted. */
  salePriceByContract: ReadonlyMap<string, number>;
  /** Empty today. Keyed by contract id. See `LedgerCharge`. */
  chargesByContract?: ReadonlyMap<string, readonly LedgerCharge[]>;
}

/**
 * What one receipt should print, computed by replaying each contract it touches
 * and reading off the position this receipt occupies.
 *
 * The receipt itself contributes nothing to these figures beyond WHICH payments
 * it covers. That is what makes a correction to an older payment flow through
 * automatically: this function is asked again, the ledger is one transaction
 * different, and the answer changes to one that still adds up.
 */
export function receiptFigures<T extends LedgerCredit & { contractId: string }>(
  input: ReceiptFiguresInput<T>,
): ReceiptFigures {
  const onThisReceipt = new Set(input.paymentIds);
  const byContract = new Map<string, T[]>();

  for (const credit of input.customerCredits) {
    const list = byContract.get(credit.contractId);

    if (list) {
      list.push(credit);
    } else {
      byContract.set(credit.contractId, [credit]);
    }
  }

  const lines: ReceiptContractLine[] = [];
  let previousBalanceCents = 0;
  let newBalanceCents = 0;
  let totalPaidCents = 0;

  for (const [contractId, credits] of byContract) {
    const charges = input.chargesByContract?.get(contractId);

    const ledger = replayContract({
      salePriceCents: input.salePriceByContract.get(contractId) ?? 0,
      credits,
      ...(charges ? { charges } : {}),
    });

    for (const line of ledger.lines) {
      if (!onThisReceipt.has(line.entry.id)) {
        continue;
      }

      lines.push({
        contractId,
        paymentId: line.entry.id,
        amountCents: line.entry.amountCents,
        balanceBeforeCents: line.balanceBeforeCents,
        balanceAfterCents: line.balanceAfterCents,
      });

      previousBalanceCents += line.balanceBeforeCents;
      newBalanceCents += line.balanceAfterCents;
      totalPaidCents += line.entry.amountCents;
    }
  }

  // Stable output regardless of Map iteration order, so two calls with the same
  // data render the same document.
  lines.sort((a, b) => (a.contractId < b.contractId ? -1 : a.contractId > b.contractId ? 1 : 0));

  return {
    lines,
    totalPaidCents,
    previousBalanceCents,
    newBalanceCents,
    cumulativePaidCents: cumulativePaidThrough(input.customerCredits, onThisReceipt),
  };
}

/**
 * Everything the customer had paid, across all their contracts, by the time
 * this receipt was issued.
 *
 * "By the time" is measured against the LAST of this receipt's payments in
 * ledger order, so a receipt covering three lots counts all three of its own
 * lines and nothing that came after it. Anything posted later — including a
 * payment back-dated into this period months from now — correctly moves this
 * figure on every receipt it precedes, which is the behaviour a frozen column
 * cannot give.
 */
function cumulativePaidThrough<T extends LedgerCredit>(
  customerCredits: readonly T[],
  onThisReceipt: ReadonlySet<string>,
): number {
  const ordered = orderLedger(customerCredits.filter(isCounted));

  let lastIndex = -1;

  for (let index = 0; index < ordered.length; index += 1) {
    if (onThisReceipt.has(ordered[index]!.id)) {
      lastIndex = index;
    }
  }

  let total = 0;

  for (let index = 0; index <= lastIndex; index += 1) {
    total += ordered[index]!.amountCents;
  }

  return total;
}
