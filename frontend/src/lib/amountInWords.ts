import type { Cents } from "./money";

/*
 * An amount written out in words, the way a receipt states it:
 *
 *   VEINTICINCO MIL LEMPIRAS EXACTOS
 *   UN MILLÓN DE LEMPIRAS EXACTOS
 *   QUINIENTOS LEMPIRAS CON 50/100
 *
 * The figure in digits can be misread or altered with a pen — a 1 turned into
 * a 7, a zero added — and the words cannot, which is why a receipt carries
 * both. Written out here rather than taken from a library: the rules are few,
 * fixed, and Spanish-specific ("veintiún", "un millón de"), and a general
 * library gets exactly those wrong.
 */

const UNITS = [
  "", "UNO", "DOS", "TRES", "CUATRO", "CINCO", "SEIS", "SIETE", "OCHO", "NUEVE",
  "DIEZ", "ONCE", "DOCE", "TRECE", "CATORCE", "QUINCE", "DIECISÉIS", "DIECISIETE",
  "DIECIOCHO", "DIECINUEVE", "VEINTE", "VEINTIUNO", "VEINTIDÓS", "VEINTITRÉS",
  "VEINTICUATRO", "VEINTICINCO", "VEINTISÉIS", "VEINTISIETE", "VEINTIOCHO", "VEINTINUEVE",
];

const TENS = ["", "", "", "TREINTA", "CUARENTA", "CINCUENTA", "SESENTA", "SETENTA", "OCHENTA", "NOVENTA"];

const HUNDREDS = [
  "", "CIENTO", "DOSCIENTOS", "TRESCIENTOS", "CUATROCIENTOS", "QUINIENTOS",
  "SEISCIENTOS", "SETECIENTOS", "OCHOCIENTOS", "NOVECIENTOS",
];

/**
 * 1–999 in words. `beforeNoun` shortens a final "uno" the way Spanish does in
 * front of a noun: "veintiún mil", "treinta y un lempiras", never "veintiuno mil".
 */
function belowThousand(n: number, beforeNoun: boolean): string {
  if (n === 100) {
    return "CIEN";
  }

  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts = hundreds > 0 ? [HUNDREDS[hundreds]!] : [];

  if (rest > 0) {
    let words =
      rest < 30
        ? UNITS[rest]!
        : TENS[Math.floor(rest / 10)]! + (rest % 10 > 0 ? ` Y ${UNITS[rest % 10]}` : "");

    if (beforeNoun && rest % 10 === 1 && rest !== 11) {
      words = rest === 21 ? "VEINTIÚN" : words.replace(/UNO$/, "UN");
    }

    parts.push(words);
  }

  return parts.join(" ");
}

/** A whole number of lempiras in words, shortened as it stands before "lempiras". */
function wholeNumber(n: number): string {
  if (n === 0) {
    return "CERO";
  }

  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;
  const parts: string[] = [];

  if (millions > 0) {
    parts.push(millions === 1 ? "UN MILLÓN" : `${wholeNumber(millions)} MILLONES`);
  }

  if (thousands > 0) {
    // "mil", not "un mil".
    parts.push(thousands === 1 ? "MIL" : `${belowThousand(thousands, true)} MIL`);
  }

  if (rest > 0) {
    parts.push(belowThousand(rest, true));
  }

  return parts.join(" ");
}

/**
 * Centavos written out for a document. Always lempiras: this states the money
 * that was handed over, whatever currency the screen happens to be showing.
 */
export function amountInWords(amount: Cents): string {
  const lempiras = Math.floor(amount / 100);
  const centavos = amount % 100;
  const words = wholeNumber(lempiras);

  // "un millón DE lempiras", but "un millón quinientos mil lempiras".
  const of = lempiras > 0 && lempiras % 1_000_000 === 0 ? " DE" : "";
  const noun = lempiras === 1 ? "LEMPIRA" : "LEMPIRAS";

  if (centavos === 0) {
    return `${words}${of} ${noun} ${lempiras === 1 ? "EXACTO" : "EXACTOS"}`;
  }

  return `${words}${of} ${noun} CON ${String(centavos).padStart(2, "0")}/100`;
}
