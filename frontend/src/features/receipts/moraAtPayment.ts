import type { MoneyView } from "../../lib/money";
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

/**
 * One charge read back as a sentence: which cuota, when it fell due, the grace
 * days, and how the amount came about.
 *
 *   La prima venció el 27 oct; pasados 5 días de gracia, el 2 nov se cargó
 *   L. 500 (10 % de los L. 30,000 que faltaban, con el máximo por cuota).
 */
export function chargeSentence(charge: PaymentMoraCharge, money: MoneyView): string {
  // As in afterPaymentLabel: on a phone "L." must not end one line and its figure start the next.
  return sentence(charge, money).replace(/(L\.|\$) /g, "$1\u00a0");
}

function sentence(charge: PaymentMoraCharge, money: MoneyView): string {
  const item = capitalized(itemName(charge.installment));
  const amount = formatMoney(charge.amount, money);
  const owed =
    charge.pending < charge.amount ? ` Quedan ${formatMoney(charge.pending, money)} por pagar.` : "";

  if (charge.manual || charge.rule === null) {
    return `${item}: ${amount} cargados a mano el ${shortDate(charge.incurredOn)}.${owed}`;
  }

  const rule = charge.rule;
  const worked =
    rule.calculation === "percent" ? Math.round((charge.unpaid * rule.percent) / 100) : rule.fixed;
  const capped = rule.cap !== null && charge.amount < worked ? ", con el máximo por cuota" : "";
  const basis =
    rule.calculation === "percent"
      ? ` (${rule.percent} % de los ${formatMoney(charge.unpaid, money)} que faltaban${capped})`
      : ` (monto fijo${capped})`;

  if (charge.repeat) {
    return `${item} seguía atrasada: el ${shortDate(charge.incurredOn)} se cargaron otra vez ${amount}${basis}.${owed}`;
  }

  const grace =
    rule.graceDays === 0
      ? ""
      : ` pasados ${rule.graceDays === 1 ? "1 día" : `${rule.graceDays} días`} de gracia,`;

  return `${item} venció el ${shortDate(charge.dueOn)};${grace} el ${shortDate(charge.incurredOn)} se cargaron ${amount}${basis}.${owed}`;
}

/**
 * The sentences for a lot, oldest first. Past `max` the rest are summed in one
 * line, so a cuota late for a year does not push the form off the screen.
 */
export function chargeSentences(lot: PaymentMoraLot, money: MoneyView, max = 3): string[] {
  const shown = lot.charges.slice(0, max).map((charge) => chargeSentence(charge, money));
  const rest = lot.charges.slice(max);

  if (rest.length > 0) {
    const total = rest.reduce((sum, charge) => sum + charge.pending, 0);
    shown.push(
      `Y ${rest.length === 1 ? "1 cargo más" : `${rest.length} cargos más`}: ${formatMoney(cents(total), money)}.`.replace(
        /(L\.|\$) /g,
        "$1\u00a0",
      ),
    );
  }

  return shown;
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
