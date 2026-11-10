import type { Cents, MoneyView } from "../../lib/money";
import { cents, formatMoney, parseMoneyInput } from "../../lib/money";
import type { PaymentMoraCharge, PaymentMoraLot } from "./api";
import type { Blocker } from "./receiptBlocker";
import { amountFieldId } from "./receiptBlocker";

/*
 * The mora under each lot in «Registrar un pago»: why it is there, and the
 * change somebody with «Cargar, perdonar o quitar mora» may make to it with
 * the payment. The owner's answers of 2026-11-06:
 *
 * - a reason only when the mora is changed;
 * - only with that permission;
 * - only on a payment dated today, so no receipt already issued changes;
 * - «Cobrar mora» on a late lot that has none.
 *
 * What a change files (a «Perdonar» for less, a «Cargar mora» for more) is
 * worked out by the server: see backend/src/lib/moraAtPayment.ts.
 */

/** A lot's mora being changed, as typed. */
export interface MoraEdit {
  /** The mora the lot is to owe right before this payment. "0" for none. */
  amount: string;
  reason: string;
}

export const DATE_FIELD = "receipt-date";

export function moraFieldId(contractId: string): string {
  return `receipt-mora-${contractId}`;
}

export function moraReasonFieldId(contractId: string): string {
  return `receipt-mora-reason-${contractId}`;
}

/** The fewest characters a reason takes, as for every other mora decision. */
export const MIN_REASON = 10;

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** "2 nov": the year goes without saying beside a cuota due weeks ago. */
export function shortDate(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1] ?? month}`;
}

export function itemName(installment: number): string {
  return installment === 0 ? "la prima" : `la cuota ${installment}`;
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** As in afterPaymentLabel: on a phone "L." must not end one line and its figure start the next. */
const keepFigures = (text: string) => text.replace(/(L\.|\$) /g, "$1\u00a0");

/** "a", "a y b", "a, b y c". */
function listed(parts: string[]): string {
  return parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`;
}

function total(charges: PaymentMoraCharge[], part: (charge: PaymentMoraCharge) => number): Cents {
  return cents(charges.reduce((sum, charge) => sum + part(charge), 0));
}

/** What the rule worked out for a charge, before its maximum. */
function worked(charge: PaymentMoraCharge): number {
  const rule = charge.rule!;
  return rule.calculation === "percent" ? Math.round((charge.unpaid * rule.percent) / 100) : rule.fixed;
}

/** The maximum per cuota, when it cut this charge short. */
function capOf(charge: PaymentMoraCharge): Cents | null {
  const cap = charge.rule?.cap ?? null;
  return cap !== null && charge.amount < worked(charge) ? cap : null;
}

/**
 * A cuota's automatic charges. `alone` when it is the cuota's only charge and
 * none of it is settled, so the line's figure already says its amount.
 *
 *   Pasados 5 días de gracia, se cargó el 10 % de los L. 2,000 que faltaban:
 *   L. 200 el 31 ago, L. 200 el 30 sep y L. 100 el 31 oct (llegó al máximo de
 *   L. 500 por cuota).
 */
function ruleSentence(charges: PaymentMoraCharge[], money: MoneyView, alone: boolean): string {
  const first = charges[0]!;
  const rule = first.rule!;
  const amountOf = (amount: Cents) => formatMoney(amount, money);
  const grace =
    first.repeat || rule.graceDays === 0
      ? ""
      : `${rule.graceDays === 1 ? "pasado 1 día" : `pasados ${rule.graceDays} días`} de gracia, `;
  const sameRule = charges.every(
    ({ rule: other }) =>
      other!.calculation === rule.calculation && other!.percent === rule.percent && other!.fixed === rule.fixed,
  );
  const sameBase = charges.every((charge) => charge.unpaid === first.unpaid);

  // What the charges share, said once, and what each one adds of its own.
  let shared = "";
  let own: (charge: PaymentMoraCharge) => string = () => "";

  if (!sameRule) {
    own = (charge) =>
      charge.rule!.calculation === "percent"
        ? `${charge.rule!.percent} % de ${amountOf(charge.unpaid)}`
        : `monto fijo de ${amountOf(charge.rule!.fixed)}`;
  } else if (rule.calculation === "fixed") {
    shared = `un monto fijo de ${amountOf(rule.fixed)}`;
  } else if (sameBase) {
    shared = `el ${rule.percent} % de los ${amountOf(first.unpaid)} que faltaban`;
  } else {
    shared = `el ${rule.percent} % de lo que faltaba`;
    own = (charge) => `de ${amountOf(charge.unpaid)}`;
  }

  if (charges.length === 1) {
    const cap = capOf(first);
    const upTo = cap === null ? "" : `, hasta el máximo de ${amountOf(cap)} por cuota`;
    const what = alone ? `se cargó ${shared}` : `se cargaron ${amountOf(first.amount)}: ${shared}`;
    return capitalized(`${grace}el ${shortDate(first.incurredOn)} ${what}${upTo}.`);
  }

  const entries = charges.map((charge) => {
    const cap = capOf(charge);
    // A fixed amount is said once, unless the maximum cut this one short.
    const amount =
      sameRule && rule.calculation === "fixed" && charge.amount === rule.fixed ? "" : `${amountOf(charge.amount)} `;
    const notes = [own(charge), cap === null ? "" : `llegó al máximo de ${amountOf(cap)} por cuota`].filter(Boolean);
    return `${amount}el ${shortDate(charge.incurredOn)}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
  });

  return capitalized(`${grace}se cargó${shared ? ` ${shared}` : ""}: ${listed(entries)}.`);
}

/** A cuota's mora put on by hand («Cargar mora»). */
function manualSentence(charges: PaymentMoraCharge[], money: MoneyView, alone: boolean): string {
  if (alone) {
    return `Se cargó a mano el ${shortDate(charges[0]!.incurredOn)}.`;
  }

  const entries = charges.map((charge) => `${formatMoney(charge.amount, money)} el ${shortDate(charge.incurredOn)}`);
  return `Cargada a mano: ${listed(entries)}.`;
}

/** What of a cuota's mora is no longer owed, and how it went. */
function settledSentence(charges: PaymentMoraCharge[], money: MoneyView): string {
  const forgiven = total(charges, (charge) => charge.forgiven);
  const paid = total(charges, (charge) => charge.amount - charge.pending - charge.forgiven);
  const parts = [
    paid > 0 ? `ya se pagaron ${formatMoney(paid, money)}` : "",
    forgiven > 0 ? `se perdonaron ${formatMoney(forgiven, money)}` : "",
  ].filter(Boolean);

  return parts.length === 0 ? "" : `${capitalized(listed(parts))}.`;
}

/**
 * One cuota's mora read back as a sentence (the owner's «B», 2026-11-09): when
 * it fell due, what it owes, and how each charge came about. The paid and
 * forgiven charges are in it too, so the figures add up.
 *
 *   Cuota 1, venció el 25 ago: L. 500. Pasados 5 días de gracia, se cargó el
 *   10 % de los L. 2,000 que faltaban: L. 200 el 31 ago, L. 200 el 30 sep y
 *   L. 100 el 31 oct (llegó al máximo de L. 500 por cuota).
 */
export function cuotaSentence(charges: PaymentMoraCharge[], money: MoneyView): string {
  const first = charges[0]!;
  const automatic = charges.filter((charge) => !charge.manual && charge.rule !== null);
  const byHand = charges.filter((charge) => charge.manual || charge.rule === null);
  const alone = charges.length === 1 && first.pending === first.amount;
  // Mora put on by hand need not wait for the cuota to fall due.
  const fellDue = charges.some((charge) => first.dueOn <= charge.incurredOn);
  const label = first.installment === 0 ? "Prima" : `Cuota ${first.installment}`;
  const owed = formatMoney(total(charges, (charge) => charge.pending), money);

  return keepFigures(
    [
      `${label}${fellDue ? `, venció el ${shortDate(first.dueOn)}` : ""}: ${owed}.`,
      automatic.length > 0 ? ruleSentence(automatic, money, alone) : "",
      byHand.length > 0 ? manualSentence(byHand, money, alone) : "",
      settledSentence(charges, money),
    ]
      .filter(Boolean)
      .join(" "),
  );
}

/**
 * A line per cuota that owes mora, the prima first. Past `max` cuotas the rest
 * share one line, so a lot late for a year does not push the form off the
 * screen; never a single cuota, which would take a line all the same and say less.
 */
export function cuotaSentences(lot: PaymentMoraLot, money: MoneyView, max = 4): string[] {
  const byCuota = new Map<number, PaymentMoraCharge[]>();

  for (const charge of lot.charges) {
    byCuota.set(charge.installment, [...(byCuota.get(charge.installment) ?? []), charge]);
  }

  const cuotas = [...byCuota.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, charges]) => charges)
    .filter((charges) => charges.some((charge) => charge.pending > 0));
  const shown = cuotas.length > max + 1 ? cuotas.slice(0, max) : cuotas;
  const rest = cuotas.slice(shown.length);
  const lines = shown.map((charges) => cuotaSentence(charges, money));

  if (rest.length > 0) {
    const numbers = rest.map((charges) => String(charges[0]!.installment));
    const owed = total(rest.flat(), (charge) => charge.pending);
    lines.push(keepFigures(`Y las cuotas ${listed(numbers)}: ${formatMoney(owed, money)}.`));
  }

  return lines;
}

/** The typed mora in centavos, or NaN when nothing usable is typed. */
export function moraTarget(edit: MoraEdit): number {
  const typed = parseMoneyInput(edit.amount);
  return Number.isNaN(typed) || typed < 0 ? Number.NaN : Math.round(typed * 100);
}

/** Is this edit a change? Not while the amount is unreadable, nor when it is what was owed. */
export function moraChanged(lot: PaymentMoraLot, edit: MoraEdit): boolean {
  const target = moraTarget(edit);
  return !Number.isNaN(target) && target !== lot.pending;
}

/** What goes with the receipt line for this lot, or undefined when the mora stays as it was. */
export function draftMora(
  lot: PaymentMoraLot | undefined,
  edit: MoraEdit | undefined,
): { amountCents: number; reason: string } | undefined {
  if (!lot || !edit || !moraChanged(lot, edit)) {
    return undefined;
  }

  return { amountCents: moraTarget(edit), reason: edit.reason.trim() };
}

export interface MoraBlockerInput {
  /** The lots in the order the form lists them. */
  lots: Array<{ id: string; code: string }>;
  mora: Record<string, PaymentMoraLot>;
  edits: Record<string, MoraEdit>;
  /** The lots this receipt puts money on. */
  receiving: ReadonlySet<string>;
  paidOn: string;
  today: string;
}

/**
 * What about a changed mora stops the receipt, and which field fixes it. Read
 * after `receiptBlocker`, which is about the money itself.
 */
export function moraBlocker(input: MoraBlockerInput): Blocker | null {
  for (const { id, code } of input.lots) {
    const edit = input.edits[id];
    const lot = input.mora[id];

    if (!edit || !lot) {
      continue;
    }

    if (Number.isNaN(moraTarget(edit))) {
      return {
        message: `Escribe la mora que se cobra a ${code}, o 0 para no cobrarla.`,
        focus: moraFieldId(id),
      };
    }

    if (!moraChanged(lot, edit)) {
      continue;
    }

    if (input.paidOn !== input.today) {
      return {
        message: `La mora de ${code} solo se cambia en un pago con la fecha de hoy. Pon la fecha de hoy o deja la mora como estaba.`,
        focus: DATE_FIELD,
      };
    }

    if (!input.receiving.has(id)) {
      return {
        message: `${code} no recibe dinero en este pago, y su mora solo se cambia con un pago. Escribe cuánto recibe o deja la mora como estaba.`,
        focus: amountFieldId(id),
      };
    }

    if (edit.reason.trim().length < MIN_REASON) {
      return {
        message: `Escribe por qué cambias la mora de ${code} (al menos ${MIN_REASON} caracteres).`,
        focus: moraReasonFieldId(id),
      };
    }
  }

  return null;
}
