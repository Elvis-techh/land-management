/**
 * Mora in «Registrar un pago»: why each lot owes the mora it owes, and what
 * changing it with the payment files.
 *
 * The owner's rules (2026-11-06):
 *
 * - Under each lot the form says why it has mora: which cuota, when it fell
 *   due, the grace days, and how the amount was worked out.
 * - Whoever holds «Cargar, perdonar o quitar mora» (`mora:charge`) may change
 *   it with the payment: less, none, or more, and «Cobrar mora» on a late lot
 *   that has none. Only on a payment dated today, so no receipt already issued
 *   changes. A reason only when it is changed.
 *
 * Nothing new is counted. Less is a «Perdonar» and more is a «Cargar mora»,
 * the same rows the contract's own mora panel writes, entered just before the
 * payment and linked to its receipt, so voiding the receipt takes them back.
 * lib/mora.ts replays them like any other.
 *
 * Nothing here reads or writes the database.
 */
import { buildSchedule } from "./contracts.js";
import { rulesOn } from "./mora.js";
function itemsOf(terms) {
    const items = [];
    let offset = 0;
    if (terms.downPaymentCents > 0) {
        items.push({ installment: 0, dueOn: terms.signedOn, startCents: 0, amountCents: terms.downPaymentCents });
        offset = terms.downPaymentCents;
    }
    for (const entry of buildSchedule(terms)) {
        items.push({ installment: entry.number, dueOn: entry.dueOn, startCents: offset, amountCents: entry.amountCents });
        offset += entry.amountCents;
    }
    return items;
}
/** The day `installment` fell due, or null when the contract has no such cuota. */
export function dueOnOf(terms, installment) {
    return itemsOf(terms).find((item) => item.installment === installment)?.dueOn ?? null;
}
/**
 * The prima or cuota a «Cobrar mora» goes on: the oldest one that fell due
 * before today and is not fully paid. Null when the lot is not late.
 *
 * `pricePaidCents` is what the payments put towards the price: everything
 * paid, less the part that paid mora.
 */
export function oldestLate(terms, pricePaidCents, today) {
    const late = itemsOf(terms).find((item) => item.dueOn < today && item.startCents + item.amountCents > pricePaidCents);
    return late ? { installment: late.installment, dueOn: late.dueOn } : null;
}
/**
 * The charges still owed, oldest first, each with the rule that made it.
 * `history` is the contract's own (see `loadContractHistory`).
 */
export function pendingCharges(account, terms, history) {
    if (!account) {
        return [];
    }
    const items = itemsOf(terms);
    const seen = new Set();
    const result = [];
    for (const charge of account.charges) {
        const manual = charge.manualId !== undefined;
        const repeat = !manual && seen.has(charge.installment);
        if (!manual) {
            seen.add(charge.installment);
        }
        const pending = account.pendingByCharge[charge.id] ?? 0;
        if (pending <= 0) {
            continue;
        }
        const rules = manual ? null : rulesOn(history, charge.incurredOn);
        result.push({
            installment: charge.installment,
            dueOn: items.find((item) => item.installment === charge.installment)?.dueOn ?? charge.incurredOn,
            incurredOn: charge.incurredOn,
            amountCents: charge.amountCents,
            pendingCents: pending,
            unpaidCents: charge.unpaidCents,
            manual,
            repeat,
            rule: rules
                ? {
                    calculation: rules.calculation,
                    percent: rules.percent,
                    fixedCents: rules.fixedCents,
                    capCents: rules.capCents,
                    graceDays: rules.graceDays,
                }
                : null,
        });
    }
    return result;
}
/**
 * The rows that leave `targetCents` of mora owed on this lot, right before
 * the payment.
 *
 * Less: forgiven from the oldest charge first, the order payments clear them
 * in, one «Perdonar» per cuota touched. More: one «Cargar mora» for the
 * difference, on the oldest late cuota (`chargeOn`), or failing that on the
 * cuota of the newest mora still owed. A lot with neither is not late, so
 * there is nothing to charge mora for.
 */
export function planMoraChange(account, targetCents, chargeOn) {
    const pending = account?.pendingCents ?? 0;
    if (targetCents === pending) {
        return { forgive: [], charge: null };
    }
    if (targetCents < pending) {
        let left = pending - targetCents;
        const byInstallment = new Map();
        for (const charge of account.charges) {
            const owed = account.pendingByCharge[charge.id] ?? 0;
            if (left <= 0 || owed <= 0) {
                continue;
            }
            const share = Math.min(left, owed);
            byInstallment.set(charge.installment, (byInstallment.get(charge.installment) ?? 0) + share);
            left -= share;
        }
        return {
            forgive: [...byInstallment].map(([installment, amountCents]) => ({ installment, amountCents })),
            charge: null,
        };
    }
    const newest = account?.charges.filter((charge) => (account.pendingByCharge[charge.id] ?? 0) > 0).at(-1);
    const installment = chargeOn ?? newest?.installment ?? null;
    if (installment === null) {
        return { problem: "Este lote no tiene cuotas atrasadas; no se le puede cobrar mora." };
    }
    return { forgive: [], charge: { installment, amountCents: targetCents - pending } };
}
/**
 * A change as the rows lib/mora.ts replays: all dated `today`, recorded at
 * `recordedAt`, which is just before the payment's own instant, so the replay
 * puts them before it and after any payment entered earlier that day. The
 * preview and POST /receipts both go through here, so they cannot disagree.
 */
export function changeRows(change, today, recordedAt, newId) {
    return {
        manual: change.charge
            ? [{ id: newId(), installment: change.charge.installment, incurredOn: today, amountCents: change.charge.amountCents }]
            : [],
        forgiveness: change.forgive.map((entry) => ({
            id: newId(),
            installment: entry.installment,
            forgivenOn: today,
            recordedAt,
            amountCents: entry.amountCents,
        })),
    };
}
/** One millisecond before `instant`: where a payment's mora change sits in the replay. */
export function justBefore(instant) {
    return new Date(Date.parse(instant) - 1).toISOString();
}
//# sourceMappingURL=moraAtPayment.js.map