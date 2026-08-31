/**
 * Splitting one payment across the lots of one purchase.
 *
 * A customer who bought three lots hands over a single amount and expects a
 * single receipt. The money still has to land on three contracts, because each
 * lot is released, titled or repossessed on its own — see the note on
 * `saleGroupId` in src/db/schema.ts.
 *
 * L 25,000 across three lots is L 8,333.333… each, which is not an amount
 * anybody writes on a receipt. What is actually done by hand is to round to
 * something payable and give one lot the difference: 8,300 + 8,300 + 8,400.
 * This file does exactly that, and picks WHICH lot gets the extra in a way that
 * evens out on its own.
 *
 * Nothing here writes anything. The transactions feature will call it to
 * propose a split, which a person can then override line by line before the
 * payments are posted — the proposal is a convenience, never a decision.
 */

/** Round each share down to a whole L 100, the way it is done on paper. */
export const DEFAULT_ROUNDING_STEP_CENTS = 10_000;

export interface AllocationTarget {
  contractId: string;
  /** Only used to break ties, so the same input always splits the same way. */
  code: string;
  /** What this contract still owes. A share never exceeds it. */
  balanceCents: number;
}

export interface Allocation {
  contractId: string;
  amountCents: number;
}

export interface AllocationResult {
  /** One entry per contract receiving money. Contracts getting nothing are omitted. */
  allocations: Allocation[];
  /**
   * What could not be placed, because the group owes less than was handed over.
   *
   * Returned rather than absorbed. Quietly pushing an extra L 5,000 onto a lot
   * that was already paid off is how a customer ends up with a credit nobody
   * can explain; the caller has to decide where it goes.
   */
  unallocatedCents: number;
}

/**
 * Divide `amountCents` as evenly as round numbers allow.
 *
 * The extra goes to the contract with the LARGEST remaining balance, which is
 * what makes the whole thing self-correcting. Three identical lots start level,
 * so the first payment's extra L 100 goes to the lowest lot number; that lot is
 * then L 100 further ahead, so next month a different lot holds the largest
 * balance and takes the extra. Over a two-year term the lots stay within one
 * rounding step of each other without anybody tracking whose turn it is.
 *
 * A lot that is already paid off drops out instead of being overpaid, and its
 * share is spread over the rest — which is why the split is not simply "divide
 * by the number of lots".
 */
export function splitEvenly(
  amountCents: number,
  targets: readonly AllocationTarget[],
  stepCents: number = DEFAULT_ROUNDING_STEP_CENTS,
): AllocationResult {
  const step = Math.max(1, Math.floor(stepCents));

  const eligible = [...targets]
    .filter((target) => target.balanceCents > 0)
    .sort((a, b) => b.balanceCents - a.balanceCents || a.code.localeCompare(b.code));

  if (amountCents <= 0 || eligible.length === 0) {
    return { allocations: [], unallocatedCents: Math.max(0, amountCents) };
  }

  // The rounded-down even share, capped per contract at what it still owes.
  const base = Math.floor(amountCents / eligible.length / step) * step;
  const assigned = eligible.map((target) => Math.min(base, target.balanceCents));

  let leftover = amountCents - assigned.reduce((total, share) => total + share, 0);

  // Hand the remainder out a step at a time, largest balance first. The final
  // sub-step remainder — the odd centavos of an amount that is not a round
  // hundred — lands on the first contract in the same order, so the split is
  // deterministic rather than dependent on floating-point luck.
  while (leftover > 0) {
    const before = leftover;

    for (let index = 0; index < eligible.length && leftover > 0; index += 1) {
      const room = eligible[index]!.balanceCents - assigned[index]!;
      const give = Math.min(step, room, leftover);

      if (give > 0) {
        assigned[index] = assigned[index]! + give;
        leftover -= give;
      }
    }

    // Nobody had room left; the rest genuinely cannot be placed.
    if (leftover === before) {
      break;
    }
  }

  return {
    allocations: eligible
      .map((target, index) => ({ contractId: target.contractId, amountCents: assigned[index]! }))
      .filter((allocation) => allocation.amountCents > 0),
    unallocatedCents: leftover,
  };
}
