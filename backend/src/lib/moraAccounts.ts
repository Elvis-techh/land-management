import { and, eq, inArray, isNull } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { contracts, payments } from "../db/schema.js";
import type { SaleType } from "./contracts.js";
import type { LedgerCharge } from "./ledger.js";
import type { MoraAccount, MoraRuleVersion } from "./mora.js";
import { moraAccount, moraEverOn } from "./mora.js";
import { readMoraHistory } from "./settings.js";
import { businessToday, parseTimestamp } from "./time.js";

/**
 * The mora of many contracts at once, read from the database.
 *
 * lib/mora.ts does the arithmetic on plain arrays; this file only gathers what
 * it needs, in two queries however many contracts are asked about, the same
 * shape every list in the app uses.
 *
 * A contract missing from the result owes no mora, and every payment on it
 * went wholly to the price. That is every contract while mora has never been
 * switched on, which is why the first thing done here is to check, and return
 * nothing without touching the payments table: until the owner turns mora on,
 * no screen pays anything for it.
 */

export interface MoraAccountsOptions {
  /** Charges up to and including this day. Normally today. */
  asOf: string;
  /** IANA name, for the day a contract was closed on. */
  timeZone: string;
  /** Only these contracts. Every contract when left out. */
  contractIds?: readonly string[];
  /** Already read by the caller; read here when left out. */
  history?: readonly MoraRuleVersion[];
  /**
   * Payments to leave out, for "what would this contract owe without this
   * payment" — the check that refuses an overpayment when a payment is
   * corrected or moved.
   */
  leaveOut?: ReadonlySet<string>;
  /**
   * A payment that has not been posted yet, for "what would this payment do":
   * the preview under each lot in «Registrar un pago». Placed after every
   * payment already on its day, as it would be if it were saved now.
   */
  adding?: { id: string; contractId: string; amountCents: number; paidOn: string };
}

const CLOSED = new Set(["cancelled", "defaulted", "replaced"]);

export function loadMoraAccounts(
  db: Pick<Db, "select">,
  options: MoraAccountsOptions,
): Map<string, MoraAccount> {
  const history = options.history ?? readMoraHistory(db);
  const accounts = new Map<string, MoraAccount>();

  if (!moraEverOn(history) || options.contractIds?.length === 0) {
    return accounts;
  }

  // Only the contracts that can carry mora: signed, and paid in cuotas.
  const carrying = and(eq(contracts.kind, "contract"), eq(contracts.saleType, "financed"));

  const rows = db
    .select({
      id: contracts.id,
      kind: contracts.kind,
      saleType: contracts.saleType,
      status: contracts.status,
      salePriceCents: contracts.salePriceCents,
      downPaymentCents: contracts.downPaymentCents,
      termMonths: contracts.termMonths,
      monthlyPaymentCents: contracts.monthlyPaymentCents,
      dueDay: contracts.dueDay,
      signedOn: contracts.signedOn,
      firstDueOn: contracts.firstDueOn,
      closedAt: contracts.closedAt,
      createdAt: contracts.createdAt,
    })
    .from(contracts)
    .where(options.contractIds ? and(carrying, inArray(contracts.id, [...options.contractIds])) : carrying)
    .all();

  if (rows.length === 0) {
    return accounts;
  }

  const credits = db
    .select({
      id: payments.id,
      contractId: payments.contractId,
      amountCents: payments.amountCents,
      paidOn: payments.paidOn,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .where(
      options.contractIds
        ? and(isNull(payments.reversedAt), inArray(payments.contractId, rows.map((row) => row.id)))
        : isNull(payments.reversedAt),
    )
    .all();

  if (options.adding) {
    credits.push({ ...options.adding, createdAt: new Date().toISOString() });
  }

  const creditsByContract = new Map<string, typeof credits>();

  for (const credit of credits) {
    if (options.leaveOut?.has(credit.id)) {
      continue;
    }

    const list = creditsByContract.get(credit.contractId);

    if (list) {
      list.push(credit);
    } else {
      creditsByContract.set(credit.contractId, [credit]);
    }
  }

  for (const row of rows) {
    // Written as an instant by the close actions; a bare date (seed data, a
    // hand fix) is already the day.
    const closedOn =
      CLOSED.has(row.status) && row.closedAt
        ? row.closedAt.length === 10
          ? row.closedAt
          : businessToday(options.timeZone, new Date(parseTimestamp(row.closedAt)))
        : null;

    accounts.set(
      row.id,
      moraAccount(
        {
          kind: row.kind,
          closedOn,
          terms: {
            saleType: row.saleType as SaleType,
            salePriceCents: row.salePriceCents,
            downPaymentCents: row.downPaymentCents,
            termMonths: row.termMonths,
            monthlyPaymentCents: row.monthlyPaymentCents,
            dueDay: row.dueDay,
            signedOn: row.signedOn ?? row.createdAt.slice(0, 10),
            firstDueOn: row.firstDueOn,
          },
        },
        creditsByContract.get(row.id) ?? [],
        history,
        options.asOf,
      ),
    );
  }

  return accounts;
}

/** One contract's account, or `undefined` when it owes no mora and never did. */
export function loadMoraAccount(
  db: Pick<Db, "select">,
  contractId: string,
  options: Omit<MoraAccountsOptions, "contractIds">,
): MoraAccount | undefined {
  return loadMoraAccounts(db, { ...options, contractIds: [contractId] }).get(contractId);
}

/** The charges as the ledger takes them, so receipts and balances include them. */
export function ledgerChargesOf(account: MoraAccount | undefined): LedgerCharge[] {
  return (account?.charges ?? []).map((entry) => ({
    id: entry.id,
    incurredOn: entry.incurredOn,
    amountCents: entry.amountCents,
    kind: "late_fee",
  }));
}
