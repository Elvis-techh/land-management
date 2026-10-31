import { and, eq, inArray, isNull } from "drizzle-orm";
import { contracts, moraContractRules, moraForgiveness, moraManualCharges, payments } from "../db/schema.js";
import { contractHistory, moraAccount, moraEverOn } from "./mora.js";
import { ownMoraSchema, readMoraHistory } from "./settings.js";
import { businessToday, parseTimestamp } from "./time.js";
const CLOSED = new Set(["cancelled", "defaulted", "replaced"]);
export function loadMoraAccounts(db, options) {
    const history = options.history ?? readMoraHistory(db);
    const accounts = new Map();
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
        .where(options.contractIds
        ? and(isNull(moraManualCharges.removedAt), inArray(moraManualCharges.contractId, [...options.contractIds]))
        : isNull(moraManualCharges.removedAt))
        .all();
    if (!moraEverOn(history) && manualRows.length === 0) {
        return accounts;
    }
    const manualByContract = new Map();
    for (const { contractId, ...entry } of manualRows) {
        const list = manualByContract.get(contractId);
        if (list) {
            list.push(entry);
        }
        else {
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
        .where(contractIds
        ? and(isNull(payments.reversedAt), inArray(payments.contractId, rows.map((row) => row.id)))
        : isNull(payments.reversedAt))
        .all();
    if (options.adding) {
        credits.push({ ...options.adding, createdAt: new Date().toISOString() });
    }
    const rulesByContract = readContractRules(db, contractIds ? rows.map((row) => row.id) : undefined);
    const forgivenessByContract = readForgiveness(db, contractIds ? rows.map((row) => row.id) : undefined);
    const creditsByContract = new Map();
    for (const credit of credits) {
        if (options.leaveOut?.has(credit.id)) {
            continue;
        }
        const list = creditsByContract.get(credit.contractId);
        if (list) {
            list.push(credit);
        }
        else {
            creditsByContract.set(credit.contractId, [credit]);
        }
    }
    for (const row of rows) {
        // Written as an instant by the close actions; a bare date (seed data, a
        // hand fix) is already the day.
        const closedOn = CLOSED.has(row.status) && row.closedAt
            ? row.closedAt.length === 10
                ? row.closedAt
                : businessToday(options.timeZone, new Date(parseTimestamp(row.closedAt)))
            : null;
        accounts.set(row.id, moraAccount({
            kind: row.kind,
            closedOn,
            terms: {
                saleType: row.saleType,
                salePriceCents: row.salePriceCents,
                downPaymentCents: row.downPaymentCents,
                termMonths: row.termMonths,
                monthlyPaymentCents: row.monthlyPaymentCents,
                dueDay: row.dueDay,
                signedOn: row.signedOn ?? row.createdAt.slice(0, 10),
                firstDueOn: row.firstDueOn,
            },
        }, creditsByContract.get(row.id) ?? [], contractHistory(history, rulesByContract.get(row.id) ?? []), options.asOf, manualByContract.get(row.id) ?? [], forgivenessByContract.get(row.id) ?? []));
    }
    return accounts;
}
/**
 * A stored contract rule as lib/mora.ts takes it. A «Regla propia» whose
 * numbers no longer pass the schema (only possible by editing the database by
 * hand) reads as the general rule rather than reaching the arithmetic.
 */
export function contractRuleOf(mode, value) {
    if (mode === "none") {
        return { mode: "none" };
    }
    if (mode === "own" && value !== null) {
        try {
            const parsed = ownMoraSchema.safeParse(JSON.parse(value));
            if (parsed.success) {
                return { mode: "own", rules: parsed.data };
            }
        }
        catch {
            // Falls through to the general rule.
        }
    }
    return { mode: "general" };
}
/** Every contract's own rule versions, by contract. Only these contracts when given. */
function readContractRules(db, contractIds) {
    const byContract = new Map();
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
        }
        else {
            byContract.set(row.contractId, [version]);
        }
    }
    return byContract;
}
/** Every «Perdonar» still counting, by contract. Only these contracts when given. */
function readForgiveness(db, contractIds) {
    const byContract = new Map();
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
        .where(contractIds
        ? and(isNull(moraForgiveness.removedAt), inArray(moraForgiveness.contractId, [...contractIds]))
        : isNull(moraForgiveness.removedAt))
        .all();
    for (const { contractId, ...entry } of rows) {
        const list = byContract.get(contractId);
        if (list) {
            list.push(entry);
        }
        else {
            byContract.set(contractId, [entry]);
        }
    }
    return byContract;
}
/** One contract's account, or `undefined` when it owes no mora and never did. */
export function loadMoraAccount(db, contractId, options) {
    return loadMoraAccounts(db, { ...options, contractIds: [contractId] }).get(contractId);
}
/**
 * The charges as the ledger takes them, so receipts and balances include them.
 * A «Perdonar» is a negative one, from the moment it was entered.
 */
export function ledgerChargesOf(account) {
    const charges = (account?.charges ?? []).map((entry) => ({
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
export function moraOwedOf(account) {
    return (account?.chargedCents ?? 0) - (account?.forgivenCents ?? 0);
}
//# sourceMappingURL=moraAccounts.js.map