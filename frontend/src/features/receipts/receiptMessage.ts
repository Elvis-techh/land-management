import type { Cents, MoneyView } from "../../lib/money";
import { formatDocumentMoney } from "../../lib/money";
import type { NextDue, Receipt, ReceiptLine } from "../../types";
import { appliedSummary } from "./appliedLabel";
import { isFinalReceipt } from "./finalReceipt";

/*
 * The message typed under the receipt in WhatsApp, written for what the
 * payment did:
 *
 *   Gracias por su pago de *L. 25,000.00* (cuota 4 de 12). Su próxima cuota es
 *   el *5 de noviembre* por *L. 25,000.00*. Cualquier duda me deja saber.
 *
 *   Gracias por su abono de *L. 15,000.00* a la cuota 4. Le quedan
 *   *L. 10,000.00* para completarla, con vencimiento el *5 de octubre*. …
 *
 *   ¡Felicidades! Con su pago de *L. 225,000.00* el lote B-12 queda *pagado en
 *   su totalidad*. …
 *
 * The image is the document; this is what a person would type beside it, so
 * it answers the one question a customer has after paying: what now? Every
 * figure comes from the same receipt the image shows, and which cuotas it
 * names comes from `appliedSummary`, the decision behind the receipt's own
 * line, so the message and the document can never disagree. The *asterisks*
 * are WhatsApp's bold.
 */

const CLOSING = "Cualquier duda me deja saber.";

/** Always lempiras: the message, like the document, states the money handed over. */
const LEMPIRAS: MoneyView = { currency: "HNL", usdRate: 1 };

function money(amount: Cents): string {
  return formatDocumentMoney(amount, LEMPIRAS);
}

/** "5 de noviembre", with the year only when it is not the receipt's own. */
function dueDate(isoDate: string, issuedOn: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const sameYear = isoDate.slice(0, 4) === issuedOn.slice(0, 4);
  const formatter = new Intl.DateTimeFormat("es-HN", {
    day: "numeric",
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });

  return formatter.format(new Date(Date.UTC(year!, month! - 1, day!)));
}

/**
 * Whether a date had already gone by on the receipt's own date. A customer who
 * is behind still has a "next" cuota, but its date is in the past, and «su
 * próxima cuota es el 5 de septiembre» sent on 20 October reads as a mistake.
 */
function isPast(isoDate: string, issuedOn: string): boolean {
  return isoDate < issuedOn;
}

/** "cuota 4 de 12", "cuotas 4 y 5 de 12", "cuotas 4 a 7 de 12". */
function cuotas(first: number, last: number, count: number, installmentCount: number): string {
  const total = installmentCount > 0 ? ` de ${installmentCount}` : "";

  if (count === 1) {
    return `cuota ${first}${total}`;
  }

  return `cuotas ${first} ${count === 2 ? "y" : "a"} ${last}${total}`;
}

/** " Su próxima cuota es el *5 de noviembre* por *L. 25,000.00*." — or nothing. */
function nextSentence(next: NextDue | null, issuedOn: string): string {
  if (next === null) {
    return "";
  }

  if (next.isDownPayment) {
    return ` Le quedan *${money(next.amount)}* de prima.`;
  }

  const date = `*${dueDate(next.dueOn, issuedOn)}*`;
  const credit = next.credit > 0 ? ` (ya abonó ${money(next.credit)})` : "";

  if (isPast(next.dueOn, issuedOn)) {
    return ` Tiene pendiente la cuota del ${date} por *${money(next.amount)}*${credit}.`;
  }

  const lead = next.monthsAhead > 0 ? "Va adelantado: su" : "Su";

  return ` ${lead} próxima cuota es el ${date} por *${money(next.amount)}*${credit}.`;
}

/** The message for a receipt on one lot. */
function singleLot(receipt: Receipt, line: ReceiptLine): string {
  const paid = `*${money(receipt.totalPaid)}*`;
  const summary = appliedSummary(line);
  const next = line.nextDue;

  if (summary?.kind === "abono") {
    const { number, remaining, dueOn } = summary.installment;

    const date = `*${dueDate(dueOn, receipt.issuedOn)}*`;
    const when = isPast(dueOn, receipt.issuedOn) ? `; venció el ${date}` : `, con vencimiento el ${date}`;

    return `Gracias por su abono de ${paid} a la cuota ${number}. Le quedan *${money(remaining)}* para completarla${when}.`;
  }

  if (summary?.kind === "finished") {
    const which = cuotas(summary.first, summary.last, summary.count, line.installmentCount);

    return `Gracias por su pago de ${paid} (${which}).${nextSentence(next, receipt.issuedOn)}`;
  }

  // No cuota touched: the money went to the prima, or there is no schedule.
  if (next?.isDownPayment) {
    return `Gracias por su abono de ${paid} a la prima. Le quedan *${money(next.amount)}* para completarla.`;
  }

  if (line.installmentCount > 0) {
    // The prima, finished by this payment: the first cuota is next.
    return `Gracias por su pago de ${paid} (prima).${nextSentence(next, receipt.issuedOn)}`;
  }

  return `Gracias por su pago de ${paid}. Su saldo pendiente es *${money(receipt.newBalance)}*.`;
}

/** One lot's part of a receipt on several: "B-12: cuota 4 de 12 · próxima cuota el 5 de noviembre por L. 25,000.00". */
function lotPart(line: ReceiptLine, issuedOn: string): string {
  const lot = line.lotCode ?? "Lote";

  if (line.newBalance === 0) {
    return `${lot}: pagado en su totalidad`;
  }

  const summary = appliedSummary(line);
  const next = line.nextDue;

  if (summary?.kind === "abono") {
    const { number, remaining, dueOn } = summary.installment;

    const when = isPast(dueOn, issuedOn) ? "venció" : "vence";

    return `${lot}: abono a la cuota ${number} · le quedan ${money(remaining)}, ${when} el ${dueDate(dueOn, issuedOn)}`;
  }

  if (next?.isDownPayment) {
    return `${lot}: abono a la prima · le quedan ${money(next.amount)}`;
  }

  const which =
    summary?.kind === "finished"
      ? cuotas(summary.first, summary.last, summary.count, line.installmentCount)
      : line.installmentCount > 0
        ? "prima"
        : `saldo ${money(line.newBalance)}`;
  const after = next
    ? ` · ${isPast(next.dueOn, issuedOn) ? "pendiente la cuota del" : "próxima cuota el"} ${dueDate(next.dueOn, issuedOn)} por ${money(next.amount)}`
    : "";

  return `${lot}: ${which}${after}`;
}

/** "B-12", "B-12 y B-13", "B-12, B-13 y C-02". */
function listLots(lines: ReceiptLine[]): string {
  const codes = lines.map((line) => line.lotCode ?? "—");

  return codes.length === 1
    ? codes[0]!
    : `${codes.slice(0, -1).join(", ")} y ${codes[codes.length - 1]}`;
}

/** The message for a receipt that is not voided. */
export function receiptMessage(receipt: Receipt): string {
  const lines = receipt.lines;

  if (isFinalReceipt(receipt) && lines.length > 0) {
    const lots =
      lines.length === 1
        ? `el lote ${listLots(lines)} queda *pagado en su totalidad*`
        : `los lotes ${listLots(lines)} quedan *pagados en su totalidad*`;

    return `¡Felicidades! Con su pago de *${money(receipt.totalPaid)}* ${lots}. ${CLOSING}`;
  }

  if (lines.length === 1) {
    return `${singleLot(receipt, lines[0]!)} ${CLOSING}`;
  }

  if (lines.length === 0) {
    return `Gracias por su pago de *${money(receipt.totalPaid)}*. ${CLOSING}`;
  }

  const parts = lines.map((line) => `• ${lotPart(line, receipt.issuedOn)}`).join("\n");

  return `Gracias por su pago de *${money(receipt.totalPaid)}*.\n${parts}\n\n${CLOSING}`;
}
