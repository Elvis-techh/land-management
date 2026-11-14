import { and, eq, inArray, isNull } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { contracts, moraContractRules, moraForgiveness, moraManualCharges, payments, receipts } from "../db/schema.js";
import type { ContractTerms, SaleType } from "./contracts.js";
import type { LedgerCharge } from "./ledger.js";
import type {
  ContractMoraRule,
  ContractMoraVersion,
  MoraAccount,
  MoraForgiveness,
  MoraManualCharge,
  MoraRuleVersion,
} from "./mora.js";
import { contractHistory, moraAccount, moraEverOn } from "./mora.js";
import type { LatestPayment } from "./moraAtPayment.js";
import { oldestLate } from "./moraAtPayment.js";
import { ownMoraSchema, readMoraHistory, readSettings } from "./settings.js";
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
  /**
   * Mora changes not entered yet, for "what would this payment do with its mora
   * changed": the same preview, with the rows POST /receipts would write
   * («Cargar mora» for more, «Perdonar» for less). See lib/moraAtPayment.ts.
   */
  adjusting?: { contractId: string; manual: MoraManualCharge[]; forgiveness: MoraForgiveness[] };
}

const CLOSED = new Set(["cancelled", "defaulted", "replaced"]);

/** Cancelled, defaulted or replaced by an adenda: it owes nothing new from then on. */
export function isClosedContract(status: string): boolean {
  return CLOSED.has(status);
}

/**
 * The day a closed contract was closed on, `null` for any other. Written as an
 * instant by the close actions; a bare date (seed data, a hand fix) is already
 * the day.
 */
export function closedOnOf(row: { status: string; closedAt: string | null }, timeZone: string): string | null {
  if (!CLOSED.has(row.status) || !row.closedAt) {
    return null;
  }

  return row.closedAt.length === 10
    ? row.closedAt
    : businessToday(timeZone, new Date(parseTimestamp(row.closedAt)));
}

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

  const manualByContract = new Map<string, MoraManualCharge[]>();
  const adjustingManual = (options.adjusting?.manual ?? []).map((entry) => ({
    ...entry,
    contractId: options.adjusting!.contractId,
  }));

  for (const { contractId, ...entry } of [...manualRows, ...adjustingManual]) {
    const list = manualByContract.get(contractId);

    if (list) {
      list.push(entry);
    } else {
      manualByContract.set(contractId, [entry]);
    }
  }

  if (!moraEverOn(history) && manualByContract.size === 0) {
    return accounts;
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
  const forgivenessByContract = readForgiveness(db, contractIds ? rows.map((row) => row.id) : undefined);

  if (options.adjusting && options.adjusting.forgiveness.length > 0) {
    const { contractId, forgiveness } = options.adjusting;
    forgivenessByContract.set(contractId, [...(forgivenessByContract.get(contractId) ?? []), ...forgiveness]);
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
    const closedOn = closedOnOf(row, options.timeZone);

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
        forgivenessByContract.get(row.id) ?? [],
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

/** Every «Perdonar» still counting, by contract. Only these contracts when given. */
function readForgiveness(
  db: Pick<Db, "select">,
  contractIds: readonly string[] | undefined,
): Map<string, MoraForgiveness[]> {
  const byContract = new Map<string, MoraForgiveness[]>();

  if (contractIds?.length === 0) {
    return byContract;
  }

  const rows = db
    .select({
      id: moraForgiveness.id,
      contractId: moraForgiveness.contractId,
      installment: moraForgiveness.installment,
      forgivenOn: moraForgiveness.forgivenOn,
      recordedAt: moraForgiveness.recordedAt,
      amountCents: moraForgiveness.amountCents,
    })
    .from(moraForgiveness)
    .where(
      contractIds
        ? and(isNull(moraForgiveness.removedAt), inArray(moraForgiveness.contractId, [...contractIds]))
        : isNull(moraForgiveness.removedAt),
    )
    .all();

  for (const { contractId, ...entry } of rows) {
    const list = byContract.get(contractId);

    if (list) {
      list.push(entry);
    } else {
      byContract.set(contractId, [entry]);
    }
  }

  return byContract;
}

/**
 * The rule history one contract's mora is worked out with: the general one
 * with its own rule laid over it. For saying which rule charged a mora.
 */
export function loadContractHistory(
  db: Pick<Db, "select">,
  contractId: string,
  history: readonly MoraRuleVersion[] = readMoraHistory(db),
): readonly MoraRuleVersion[] {
  return contractHistory(history, readContractRules(db, [contractId]).get(contractId) ?? []);
}

/** One contract's account, or `undefined` when it owes no mora and never did. */
export function loadMoraAccount(
  db: Pick<Db, "select">,
  contractId: string,
  options: Omit<MoraAccountsOptions, "contractIds">,
): MoraAccount | undefined {
  return loadMoraAccounts(db, { ...options, contractIds: [contractId] }).get(contractId);
}

/**
 * The charges as the ledger takes them, so receipts and balances include them.
 * A «Perdonar» is a negative one, from the moment it was entered.
 */
export function ledgerChargesOf(account: MoraAccount | undefined): LedgerCharge[] {
  const charges: LedgerCharge[] = (account?.charges ?? []).map((entry) => ({
    id: entry.id,
    incurredOn: entry.incurredOn,
    amountCents: entry.amountCents,
    kind: "late_fee",
  }));

  for (const entry of account?.forgiven ?? []) {
    if (entry.amountCents > 0) {
      charges.push({
        id: entry.id,
        incurredOn: entry.forgivenOn,
        amountCents: -entry.amountCents,
        kind: "late_fee_forgiven",
        recordedAt: entry.recordedAt,
      });
    }
  }

  return charges;
}

/** Mora charged and not forgiven: what price + this − paid counts as owed. */
export function moraOwedOf(account: MoraAccount | undefined): number {
  return (account?.chargedCents ?? 0) - (account?.forgivenCents ?? 0);
}

/** What «Registrar un pago» needs about one lot's mora. See lib/moraAtPayment.ts. */
export interface PaymentMora {
  contractId: string;
  /** A signed contract paid in cuotas, still open: its mora can be changed with a payment. */
  carriesMora: boolean;
  terms: ContractTerms;
  /** Undefined when it owes no mora and never did. */
  account: MoraAccount | undefined;
  /** Its own rule history, for saying which rule charged each mora. */
  history: readonly MoraRuleVersion[];
  /** The oldest prima or cuota past its grace days and not fully paid: where «Cobrar mora» goes. */
  late: { installment: number; dueOn: string } | null;
}

/** Statuses whose mora can still change: open, or paid off (a charge may reopen it). */
const MORA_OPEN = new Set(["active", "paid_off"]);

/**
 * The mora of these lots as «Registrar un pago» shows and changes it, as of
 * `asOf` and before any payment being typed. A few queries however many lots.
 */
export function loadPaymentMora(
  db: Pick<Db, "select">,
  contractIds: readonly string[],
  options: { asOf: string; timeZone: string },
): Map<string, PaymentMora> {
  const result = new Map<string, PaymentMora>();

  if (contractIds.length === 0) {
    return result;
  }

  const rows = db
    .select({
      id: contracts.id,
      kind: contracts.kind,
      status: contracts.status,
      saleType: contracts.saleType,
      salePriceCents: contracts.salePriceCents,
      downPaymentCents: contracts.downPaymentCents,
      termMonths: contracts.termMonths,
      monthlyPaymentCents: contracts.monthlyPaymentCents,
      dueDay: contracts.dueDay,
      signedOn: contracts.signedOn,
      firstDueOn: contracts.firstDueOn,
      createdAt: contracts.createdAt,
    })
    .from(contracts)
    .where(inArray(contracts.id, [...contractIds]))
    .all();

  const paidByContract = new Map<string, number>();

  for (const payment of db
    .select({ contractId: payments.contractId, amountCents: payments.amountCents })
    .from(payments)
    .where(and(isNull(payments.reversedAt), inArray(payments.contractId, [...contractIds])))
    .all()) {
    paidByContract.set(payment.contractId, (paidByContract.get(payment.contractId) ?? 0) + payment.amountCents);
  }

  const general = readMoraHistory(db);
  const graceDays = readSettings(db).mora.graceDays;
  const accounts = loadMoraAccounts(db, { ...options, contractIds, history: general });
  const rules = readContractRules(db, contractIds);

  for (const row of rows) {
    const terms: ContractTerms = {
      saleType: row.saleType as SaleType,
      salePriceCents: row.salePriceCents,
      downPaymentCents: row.downPaymentCents,
      termMonths: row.termMonths,
      monthlyPaymentCents: row.monthlyPaymentCents,
      dueDay: row.dueDay,
      signedOn: row.signedOn ?? row.createdAt.slice(0, 10),
      firstDueOn: row.firstDueOn,
    };
    const account = accounts.get(row.id);
    const pricePaid = (paidByContract.get(row.id) ?? 0) - (account?.paidCents ?? 0);
    const carriesMora = row.kind === "contract" && row.saleType === "financed" && MORA_OPEN.has(row.status);

    result.set(row.id, {
      contractId: row.id,
      carriesMora,
      terms,
      account,
      history: contractHistory(general, rules.get(row.id) ?? []),
      late: carriesMora ? oldestLate(terms, pricePaid, options.asOf, graceDays) : null,
    });
  }

  return result;
}

/**
 * The newest payment still standing on each of these lots, with its receipt's
 * code: what decides whether a lot's mora can be changed with a payment on a
 * given date (`moraChangeRefusal`). A lot with none is missing.
 */
export function latestPayments(
  db: Pick<Db, "select">,
  contractIds: readonly string[],
): Map<string, LatestPayment> {
  const result = new Map<string, LatestPayment & { createdAt: string }>();

  if (contractIds.length === 0) {
    return result;
  }

  for (const row of db
    .select({
      contractId: payments.contractId,
      paidOn: payments.paidOn,
      createdAt: payments.createdAt,
      receiptCode: receipts.code,
    })
    .from(payments)
    .leftJoin(receipts, eq(receipts.id, payments.receiptId))
    .where(and(isNull(payments.reversedAt), inArray(payments.contractId, [...contractIds])))
    .all()) {
    const known = result.get(row.contractId);

    if (
      !known ||
      row.paidOn > known.paidOn ||
      (row.paidOn === known.paidOn && parseTimestamp(row.createdAt) > parseTimestamp(known.createdAt))
    ) {
      result.set(row.contractId, { paidOn: row.paidOn, receiptCode: row.receiptCode, createdAt: row.createdAt });
    }
  }

  return result;
}

/** A lot's mora for a payment on a given date, and what decides whether it can be changed. */
export interface PaymentMoraOn extends PaymentMora {
  /** The day the figures are as of: the payment's date, or today. */
  on: string;
  latest: LatestPayment | null;
}

/**
 * The mora of these lots as «Registrar un pago» shows and changes it for a
 * payment dated `paidOn`.
 *
 * Dated before today, a lot is shown as it stood THAT day, the mora a change
 * would be made against (the owner's rule of 2026-11-12). Except a lot with a
 * payment dated after it: its mora cannot be changed then, and the replay of
 * that day would count the later payment too, so it is shown as it is today.
 * Today or later, as today.
 */
export function loadPaymentMoraOn(
  db: Pick<Db, "select">,
  contractIds: readonly string[],
  paidOn: string,
  options: { asOf: string; timeZone: string },
): Map<string, PaymentMoraOn> {
  const latest = latestPayments(db, contractIds);
  const past = (id: string) => paidOn < options.asOf && !((latest.get(id)?.paidOn ?? "") > paidOn);
  const then = loadPaymentMora(db, contractIds.filter(past), { ...options, asOf: paidOn });
  const now = loadPaymentMora(
    db,
    contractIds.filter((id) => !past(id)),
    options,
  );
  const result = new Map<string, PaymentMoraOn>();

  // In the order asked for.
  for (const id of contractIds) {
    const lot = then.get(id) ?? now.get(id);
    const found = latest.get(id);

    if (lot) {
      result.set(id, {
        ...lot,
        on: then.has(id) ? paidOn : options.asOf,
        latest: found ? { paidOn: found.paidOn, receiptCode: found.receiptCode } : null,
      });
    }
  }

  return result;
}
