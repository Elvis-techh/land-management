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
 * Rounding to whole hundreds only works while every lot ends up with at least
 * what it currently owes — a plain even split can round one lot DOWN below its
 * own next installment while stacking the difference onto another, which posts
 * as a late or incomplete payment even though the total handed over was enough
 * for everybody. `splitEvenly` checks for that before returning, and only
 * changes its answer when the plain split would actually starve a lot.
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
  /**
   * What this contract's own next installment still needs, already capped at
   * the balance. A plain even split can hand this lot less than that while
   * another lot takes the surplus, which is what makes it read as late or
   * incomplete a moment later. Left out or zero for a contract with nothing
   * of the kind due right now — paid ahead, or no schedule at all — which
   * simply means the split has no floor to protect for it.
   */
  minimumDueCents?: number;
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
  /**
   * Contracts that still came up short of their own `minimumDueCents`, because
   * the total handed over was not enough to cover every lot's current
   * installment even after favoring the smallest ones first. Empty in the
   * ordinary case. The caller surfaces this so a person notices and moves
   * money between lines instead of quietly posting a payment that reads as
   * late for a lot the screen never warned them about.
   */
  shortOfMinimumContractIds: string[];
}

/**
 * Spread `remaining` across whoever in `eligible` still has room left, given
 * what `assigned` already holds for each of them, rounding down to a whole
 * `step` and handing the odd remainder to the contract with the largest
 * balance — first in `eligible`'s own order, which is sorted that way by the
 * caller. Mutates `assigned` in place and returns whatever could not be
 * placed because nobody had room for it.
 */
function spreadRemainder(
  remaining: number,
  eligible: readonly AllocationTarget[],
  assigned: number[],
  step: number,
): number {
  if (remaining <= 0) {
    return remaining;
  }

  const room = eligible.map((target, index) => target.balanceCents - assigned[index]!);
  const withRoom = room.filter((value) => value > 0).length;

  if (withRoom === 0) {
    return remaining;
  }

  const base = Math.floor(remaining / withRoom / step) * step;

  for (let index = 0; index < eligible.length; index += 1) {
    const give = Math.min(base, room[index]!);
    assigned[index] = assigned[index]! + give;
    remaining -= give;
  }

  // Hand the remainder out a step at a time. The final sub-step remainder —
  // the odd centavos of an amount that is not a round hundred — lands on the
  // first contract with room, so the split is deterministic rather than
  // dependent on floating-point luck.
  while (remaining > 0) {
    const before = remaining;

    for (let index = 0; index < eligible.length && remaining > 0; index += 1) {
      const give = Math.min(step, eligible[index]!.balanceCents - assigned[index]!, remaining);

      if (give > 0) {
        assigned[index] = assigned[index]! + give;
        remaining -= give;
      }
    }

    // Nobody had room left; the rest genuinely cannot be placed.
    if (remaining === before) {
      break;
    }
  }

  return remaining;
}

/**
 * Divide `amountCents` as evenly as round numbers allow, without ever handing
 * a lot less than its own next installment.
 *
 * The plain rule is tried first: equal shares rounded down to a whole step,
 * the extra going to the contract with the LARGEST remaining balance. Three
 * identical lots start level, so the first payment's extra L 100 goes to the
 * lowest lot number; that lot is then L 100 further ahead, so next month a
 * different lot holds the largest balance and takes the extra. Over a
 * two-year term the lots stay within one rounding step of each other without
 * anybody tracking whose turn it is — and this is returned as-is whenever it
 * already leaves every lot with at least its own `minimumDueCents`, which is
 * true most of the time.
 *
 * When it would not — a lot with a small balance but a full installment due
 * NOW can lose out to a lot that merely owes more overall — every lot is
 * guaranteed its own minimum first, smallest minimum first so that a total
 * too small to cover everyone still clears as many lots as possible rather
 * than leaving an arbitrary one behind, and only what is left over is spread
 * the same way as the plain rule above.
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
    return {
      allocations: [],
      unallocatedCents: Math.max(0, amountCents),
      shortOfMinimumContractIds: [],
    };
  }

  const minimums = eligible.map((target) =>
    Math.min(Math.max(0, target.minimumDueCents ?? 0), target.balanceCents),
  );

  const plain = eligible.map(() => 0);
  const plainLeftover = spreadRemainder(amountCents, eligible, plain, step);

  if (eligible.every((_, index) => plain[index]! >= minimums[index]!)) {
    return {
      allocations: eligible
        .map((target, index) => ({ contractId: target.contractId, amountCents: plain[index]! }))
        .filter((allocation) => allocation.amountCents > 0),
      unallocatedCents: plainLeftover,
      shortOfMinimumContractIds: [],
    };
  }

  const floored = eligible.map(() => 0);
  let remaining = amountCents;

  const byMinimum = eligible
    .map((_, index) => index)
    .sort((a, b) => minimums[a]! - minimums[b]! || eligible[a]!.code.localeCompare(eligible[b]!.code));

  for (const index of byMinimum) {
    if (remaining <= 0) {
      break;
    }

    const give = Math.min(minimums[index]!, remaining);
    floored[index] = give;
    remaining -= give;
  }

  const leftover = spreadRemainder(remaining, eligible, floored, step);

  return {
    allocations: eligible
      .map((target, index) => ({ contractId: target.contractId, amountCents: floored[index]! }))
      .filter((allocation) => allocation.amountCents > 0),
    unallocatedCents: leftover,
    shortOfMinimumContractIds: eligible
      .map((target, index) => (floored[index]! < minimums[index]! ? target.contractId : null))
      .filter((id): id is string => id !== null),
  };
}
