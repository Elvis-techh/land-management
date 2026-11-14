import type { MoneyView } from "../../lib/money";
import { formatMoney } from "../../lib/money";
import { appliedLabel, appliedSummary } from "./appliedLabel";
import type { AfterPayment } from "./api";
import { shortDate } from "./moraAtPayment";

/** One box of the «Después de este pago» list. */
export interface AfterBox {
  key: "applied" | "next" | "mora";
  text: string;
  /** A smaller line under the text, when the figure needs explaining. */
  note?: string;
  /** "ok" green (finished), "due" red (still owed), "plain" neither. */
  tone: "ok" | "due" | "plain";
}

/**
 * What the lot looks like after this payment, under it in «Registrar un pago»,
 * one fact per box (owner, 13 Nov 2026: «a visual breakdown»):
 *
 *   [Cuota 4 de 12 · completa]          green
 *   [Próxima cuota L. 25,000]
 *   [Mora por pagar L. 600]             red
 *    cargada después del 5 oct, en las cuotas 2 y 3
 *
 * The first box is the receipt's own wording (`appliedLabel`), so what the
 * person reads while typing is what the receipt will print; red when the
 * payment finished no cuota. The second is what is owed next: the next cuota
 * and any advance on it, the rest of the prima, or that nothing is left. The
 * part of the money that pays mora is not here, it is the «Mora» line of the
 * list above (paymentParts.ts). Mora still owed afterwards comes last.
 *
 * These are the lot TODAY with the payment in its place. With an earlier date,
 * `paidOn` is that date: mora charged after it cannot have been paid by it,
 * and the mora box says how much of it that is and on which cuotas, so
 * «L. 200 de mora» above and «L. 600 por pagar» here do not read as a sum
 * that does not add up (owner, 13 Nov 2026).
 */
export function afterPaymentBoxes(after: AfterPayment, money: MoneyView, paidOn?: string): AfterBox[] {
  const boxes: AfterBox[] = [];
  const applied = appliedLabel(after, money);
  // A partial abono: the cuota still needs money, said in its own box
  // ("faltan L. 10,000.00"), so the next box gives the balance instead.
  const isAbono = applied !== null && appliedSummary(after)?.kind === "abono";

  if (applied !== null) {
    boxes.push({ key: "applied", text: keepFigures(applied), tone: isAbono ? "due" : "ok" });
  }

  const next = (text: string, tone: AfterBox["tone"] = "plain") =>
    boxes.push({ key: "next", text: keepFigures(text), tone });

  if (after.settled) {
    next("Contrato pagado", "ok");
  } else if (isAbono) {
    next(`Saldo ${formatMoney(after.newBalance, money)}`);
  } else if (after.nextDueIsDownPayment) {
    next(`Faltan ${formatMoney(after.nextDueAmount, money)} de prima`, "due");
  } else if (after.nextDueCredit > 0) {
    // The next cuota is already started: say how much of it is covered.
    next(
      `Próxima cuota ${formatMoney(after.nextInstallment, money)} · adelanto ${formatMoney(after.nextDueCredit, money)}`,
    );
  } else if (after.nextInstallment > 0) {
    next(`Próxima cuota ${formatMoney(after.nextInstallment, money)}`);
  } else {
    next(`Saldo ${formatMoney(after.newBalance, money)}`);
  }

  if (after.moraPending > 0) {
    const box: AfterBox = {
      key: "mora",
      text: keepFigures(`Mora por pagar ${formatMoney(after.moraPending, money)}`),
      tone: "due",
    };

    if (paidOn && after.moraPendingLater > 0) {
      const all = after.moraPendingLater >= after.moraPending;
      const where = after.moraLaterInstallments.length > 0 ? `, en ${items(after.moraLaterInstallments)}` : "";

      box.note = keepFigures(
        `${all ? "Cargada" : `${formatMoney(after.moraPendingLater, money)} cargada`} después del ${shortDate(paidOn)}${where}`,
      );
    }

    boxes.push(box);
  }

  return boxes;
}

/** "la cuota 2", "las cuotas 2 y 3", "la prima", "la prima y la cuota 1". 0 is the prima. */
function items(installments: readonly number[]): string {
  const prima = installments.includes(0);
  const cuotas = installments.filter((number) => number > 0);
  const list =
    cuotas.length === 1 ? String(cuotas[0]) : `${cuotas.slice(0, -1).join(", ")} y ${cuotas[cuotas.length - 1]}`;
  const named = cuotas.length === 0 ? "" : cuotas.length === 1 ? `la cuota ${list}` : `las cuotas ${list}`;

  if (!prima) {
    return named;
  }

  return named === "" ? "la prima" : `la prima y ${named}`;
}

/**
 * A non-breaking space after the currency sign: when a box wraps on a phone,
 * "L." must not be left at the end of one line and its figure on the next.
 */
function keepFigures(text: string): string {
  return text.replace(/(L\.|\$) /g, "$1 ");
}
