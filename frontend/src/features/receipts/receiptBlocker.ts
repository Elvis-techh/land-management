/**
 * What stops a receipt draft from being issued, and which field fixes it.
 *
 * Split out of `NewReceiptDialog` so the rule can be tested directly. The
 * question it answers is the one the form used to answer by going quiet: the
 * submit button was `disabled` whenever the draft was incomplete, which looked
 * tidy and told the user nothing. Somebody who picks a customer, forgets the
 * monto and presses "Registrar y emitir recibo" got no response at all — and a
 * dead button is indistinguishable from a frozen page, or from a receipt that
 * saved without saying so.
 */

/** Just enough of a payable contract to decide, so tests need no fixtures. */
export interface BlockerContract {
  id: string;
}

export interface BlockerInput {
  customerId: string;
  /** Active contracts for the chosen customer — what money can be put on. */
  payable: BlockerContract[];
  /** How many lines the draft actually produced (amount typed and above zero). */
  lineCount: number;
  /** The raw text in each lot's amount field, by contract id. */
  amountByContract: Record<string, string>;
  /** The raw text in "Total entregado". Only shown when there are several lots. */
  totalText: string;
}

export interface Blocker {
  /** Said to the user, in full sentences. */
  message: string;
  /** The DOM id of the field that fixes it, so the caret can be put there. */
  focus: string;
}

export const CUSTOMER_FIELD = "receipt-customer";
export const TOTAL_FIELD = "receipt-total";

/** The DOM id `NewReceiptDialog` gives one lot's amount input. */
export function amountFieldId(contractId: string): string {
  return `receipt-amount-${contractId}`;
}

/**
 * `null` when the draft is ready to submit.
 *
 * Ordered from the top of the form down, so a draft missing several things
 * names the one the user would reach first rather than the last one checked.
 */
export function receiptBlocker(input: BlockerInput): Blocker | null {
  const { customerId, payable, lineCount, amountByContract, totalText } = input;

  if (customerId === "") {
    return { message: "Elige el cliente que está pagando.", focus: CUSTOMER_FIELD };
  }

  if (payable.length === 0) {
    return {
      message:
        "Este cliente no tiene contratos que admitan pagos, así que no se le puede registrar uno.",
      focus: CUSTOMER_FIELD,
    };
  }

  if (lineCount > 0) {
    return null;
  }

  const firstAmount = amountFieldId(payable[0]!.id);
  const isMultiLot = payable.length > 1;

  // Typed, but nothing a receipt can be made of — a lone "0", or a field
  // cleared back to empty after having been filled in.
  if (payable.some((contract) => (amountByContract[contract.id] ?? "").trim() !== "")) {
    return { message: "El monto tiene que ser mayor que cero.", focus: firstAmount };
  }

  // The total is filled in but never divided, so every line is still empty.
  // Worth its own sentence: the form looks complete from across the counter,
  // and the fix is one button away.
  if (isMultiLot && totalText.trim() !== "") {
    return {
      message:
        "Falta repartir el total entregado. Pulsa «Repartir entre los lotes», o escribe el monto lote por lote.",
      focus: firstAmount,
    };
  }

  return isMultiLot
    ? {
        message: "Falta el monto. Escribe el total entregado y repártelo, o llena cada lote.",
        focus: TOTAL_FIELD,
      }
    : { message: "Falta el monto que está pagando el cliente.", focus: firstAmount };
}
