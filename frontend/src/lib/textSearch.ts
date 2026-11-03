import { formatPhone } from "./phone";

/**
 * The rule behind the search boxes of Lotes, Contratos, Clientes and Recibos.
 *
 * Every word typed has to match something on the row, so more words narrow the
 * list. Capitals and accents never matter: «jose» finds «José».
 *
 * A word that is only a number has to BE a number on the row, as it is written:
 * «9» finds «Etapa 9» and not CT-2026-009, and «01» finds A-01. Before this,
 * «Etapa 9» also brought every lot whose contract or phone had a 9 anywhere.
 *
 * From four digits up, it can be part of a longer number, which is how people
 * remember a bank reference or the end of a phone. That is also where phones
 * and identity numbers start to count: any short number is inside most of them.
 */

/** What one row offers to the search box. */
export interface SearchFields {
  /** Names, codes, notes: read as they are written. */
  text: ReadonlyArray<string | null | undefined>;
  /** As stored, "+50499824471". */
  phones?: ReadonlyArray<string | null | undefined>;
  identities?: ReadonlyArray<string | null | undefined>;
}

/** From here a number can be part of a longer one, and phones count. */
const LONG_NUMBER_DIGITS = 4;

const present = (values: ReadonlyArray<string | null | undefined> = []) =>
  values.filter((value): value is string => Boolean(value));

function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function matchesWord(word: string, text: string, fields: SearchFields): boolean {
  const phones = present(fields.phones);
  const identities = present(fields.identities);

  if (!/^\d+$/.test(word)) {
    // As people write them: "+504", "9982-4471", "0801-1990-12345".
    const written = fold([...phones, ...phones.map(formatPhone), ...identities].join(" "));

    return text.includes(word) || written.includes(word);
  }

  if (word.length < LONG_NUMBER_DIGITS) {
    return text.match(/\d+/g)?.includes(word) ?? false;
  }

  // Without the separators, and a phone without its country code: every
  // Honduran number starts with 504, which is no reason to match «5049».
  const digits = [...phones.map(formatPhone), ...identities].map((value) => value.replace(/\D/g, ""));

  return text.includes(word) || digits.some((number) => number.includes(word));
}

export function searchRows<Row>(
  rows: Row[],
  search: string,
  fieldsOf: (row: Row) => SearchFields,
): Row[] {
  const words = fold(search).split(/\s+/).filter((word) => word !== "");

  if (words.length === 0) {
    return rows;
  }

  return rows.filter((row) => {
    const fields = fieldsOf(row);
    const text = fold(present(fields.text).join(" "));

    return words.every((word) => matchesWord(word, text, fields));
  });
}
