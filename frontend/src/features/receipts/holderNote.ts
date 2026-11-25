import type { Receipt } from "../../types";

/**
 * What to say beside a receipt issued before its lot was handed to somebody
 * else («Traspasar»), or `null` when every lot on it is still its customer's.
 *
 * The paper keeps the name it was made out to: it was true on its day, and the
 * customer may already have it. Somebody opening it from the new holder's list
 * would otherwise read a name that is not the one they clicked on, with
 * nothing to say why. So the office is told, here and never on the document.
 */
export function holderNote(receipt: Pick<Receipt, "customer" | "lines">): string | null {
  const handedOver = receipt.lines.filter(
    (line) => line.holder !== null && line.holder.id !== receipt.customer.id,
  );

  if (handedOver.length === 0) {
    return null;
  }

  const lots = handedOver.map((line) => {
    const lot = line.lotCode ? `el lote ${line.lotCode}` : "el lote";
    return `${lot} es de ${line.holder!.fullName}`;
  });

  return (
    `Este recibo se emitió a nombre de ${receipt.customer.fullName}, antes de un traspaso: ` +
    `hoy ${lots.join(" y ")}. Se queda con el nombre que se le dio.`
  );
}
