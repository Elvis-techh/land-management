import { and, eq, inArray, isNull } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { contracts, moraContractRules, moraManualCharges, payments } from "../db/schema.js";
import type { SaleType } from "./contracts.js";
import type { LedgerCharge } from "./ledger.js";
import type { ContractMoraRule, ContractMoraVersion, MoraAccount, MoraManualCharge, MoraRuleVersion } from "./mora.js";
import { contractHistory, moraAccount, moraEverOn } from "./mora.js";
import { ownMoraSchema, readMoraHistory } from "./settings.js";
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
 * switched on and none was put on by hand, which is why the first thing done
 * here is to check, and return nothing without touching the payments table:
 * until then, no screen pays anything for it.
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

  if (options.contractIds?.length === 0) {
    return accounts;
  }

  const manualRows = db
    .select({
      id: moraManualCharges.id,
      contractId: moraManualCharges.contractId,
      installment: moraManualCharges.installment,
      incurredOn: moraManualCharges.incurredOn,
      amountCents: moraManualCharges.amountCents,
    })
    .from(moraManualCharges)
    .where(
      options.contractIds
        ? and(
            isNull(moraManualCharges.removedAt),
            inArray(moraManualCharges.contractId, [...options.contractIds]),
          )
        : isNull(moraManualCharges.removedAt),
    )
    .all();

  if (!moraEverOn(history) && manualRows.length === 0) {
    return accounts;
  }

  const manualByContract = new Map<string, MoraManualCharge[]>();

  for (const { contractId, ...entry } of manualRows) {
    const list = manualByContract.get(contractId);

    if (list) {
      list.push(entry);
    } else {
      manualByContract.set(contractId, [entry]);
    }
  }

  // Mora never switched on: only the contracts with mora put on by hand.
  const contractIds = moraEverOn(history) ? options.contractIds : [...manualByContract.keys()];

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
    .where(contractIds ? and(carrying, inArray(contracts.id, [...contractIds])) : carrying)
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
      contractIds
        ? and(isNull(payments.reversedAt), inArray(payments.contractId, rows.map((row) => row.id)))
        : isNull(payments.reversedAt),
    )
    .all();

  if (options.adding) {
    credits.push({ ...options.adding, createdAt: new Date().toISOString() });
  }

  const rulesByContract = readContractRules(db, contractIds ? rows.map((row) => row.id) : undefined);
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
        contractHistory(history, rulesByContract.get(row.id) ?? []),
        options.asOf,
        manualByContract.get(row.id) ?? [],
      ),
    );
  }

  return accounts;
}

/**
 * A stored contract rule as lib/mora.ts takes it. A «Regla propia» whose
 * numbers no longer pass the schema (only possible by editing the database by
 * hand) reads as the general rule rather than reaching the arithmetic.
 */
export function contractRuleOf(mode: string, value: string | null): ContractMoraRule {
  if (mode === "none") {
    return { mode: "none" };
  }

  if (mode === "own" && value !== null) {
    try {
      const parsed = ownMoraSchema.safeParse(JSON.parse(value));

      if (parsed.success) {
        return { mode: "own", rules: parsed.data };
      }
    } catch {
      // Falls through to the general rule.
    }
  }

  return { mode: "general" };
}

/** Every contract's own rule versions, by contract. Only these contracts when given. */
function readContractRules(
  db: Pick<Db, "select">,
  contractIds: readonly string[] | undefined,
): Map<string, ContractMoraVersion[]> {
  const byContract = new Map<string, ContractMoraVersion[]>();

  if (contractIds?.length === 0) {
    return byContract;
  }

  const rows = db
    .select({
      contractId: moraContractRules.contractId,
      effectiveFrom: moraContractRules.effectiveFrom,
      mode: moraContractRules.mode,
      value: moraContractRules.value,
    })
    .from(moraContractRules)
    .where(contractIds ? inArray(moraContractRules.contractId, [...contractIds]) : undefined)
    .all();

  for (const row of rows) {
    const version = { effectiveFrom: row.effectiveFrom, rule: contractRuleOf(row.mode, row.value) };
    const list = byContract.get(row.contractId);

    if (list) {
      list.push(version);
    } else {
      byContract.set(row.contractId, [version]);
    }
  }

  return byContract;
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
