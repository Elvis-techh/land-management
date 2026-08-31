/**
 * Code 128 (subset B), rendered as inline SVG.
 *
 * The receipt this replaces fetched its barcode from
 * `bwipjs-api.metafloor.com` as an <img> src. That is a network round trip in
 * the middle of printing a document — the one moment the app must not depend on
 * somebody else's uptime, because the failure mode is a receipt that prints
 * with a blank rectangle where the barcode goes and nobody notices until the
 * customer is holding it. It also handed every receipt code we have ever issued
 * to a third party as a query string.
 *
 * The encoder is about eighty lines, so it lives here instead.
 */

/**
 * The 106 symbol patterns, as element widths: bar, space, bar, space, bar,
 * space. Index is the Code 128 value, not the character: 0-102 are data, 103,
 * 104 and 105 are the three start symbols, and Stop (106) is `STOP` below
 * because it is the one symbol with a different shape.
 *
 * Every pattern is eleven modules wide, which is what `assertPatternTable`
 * below checks at module load — a mistyped digit in this table would otherwise
 * produce a barcode that looks perfectly convincing and scans as nothing.
 */
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312",
  "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
  "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131",
  "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
  "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
  "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
  "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
  "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
  "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112",
  "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
  "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
  "211214", "211232",
];

/** The stop symbol, uniquely thirteen modules and seven elements wide. */
const STOP = "2331112";

const START_B = 104;

/**
 * Guards the table above. Called once, at module load, because a barcode that
 * does not scan is invisible until it is in somebody's hand.
 */
function assertPatternTable(): void {
  const widthOf = (pattern: string) =>
    [...pattern].reduce((total, digit) => total + Number(digit), 0);

  PATTERNS.forEach((pattern, value) => {
    if (pattern.length !== 6 || widthOf(pattern) !== 11) {
      throw new Error(`Code 128 pattern ${value} is malformed: ${pattern}`);
    }
  });

  if (PATTERNS.length !== 106 || widthOf(STOP) !== 13) {
    throw new Error(`Code 128 table is the wrong size: ${PATTERNS.length} of 106`);
  }
}

assertPatternTable();

/**
 * The symbol values for one string: start, data, checksum, stop.
 *
 * Subset B covers ASCII 32–126, which every receipt code we generate lives
 * inside. Anything outside it is dropped rather than encoded wrongly — a
 * barcode that scans as the wrong code is worse than one character short.
 */
function symbolsFor(text: string): number[] {
  const values = [...text]
    .map((character) => character.charCodeAt(0))
    .filter((code) => code >= 32 && code <= 126)
    .map((code) => code - 32);

  // The check digit is a position-weighted sum: the start symbol counts once,
  // then each data symbol is multiplied by its 1-based position.
  const checksum = values.reduce(
    (total, value, index) => total + value * (index + 1),
    START_B,
  );

  return [START_B, ...values, checksum % 103];
}

/** The bar/space run lengths, in modules, left to right. Always starts on a bar. */
export function code128Modules(text: string): number[] {
  return [
    ...symbolsFor(text).flatMap((value) => [...PATTERNS[value]!].map(Number)),
    ...[...STOP].map(Number),
  ];
}

/** The geometry of one barcode, in modules. The caller scales it with CSS. */
export interface Code128Geometry {
  /** An SVG path covering every bar. Numbers only — nothing from `text`. */
  path: string;
  width: number;
  height: number;
}

/**
 * The bars of a barcode, as an SVG path.
 *
 * Returned as geometry rather than as finished markup so the caller renders a
 * real element instead of injecting a string, and so the size is chosen in CSS
 * where the rest of the receipt's sizing lives.
 *
 * One `<path>` of black bars on a transparent ground: a print driver that
 * decides to be clever about background colours cannot erase the quiet zone,
 * because there is no background to erase.
 */
export function code128Geometry(text: string, heightModules = 40): Code128Geometry {
  const modules = code128Modules(text);

  // Ten modules of clear space either side. Below that a scanner can read the
  // page edge, or the text beside it, as part of the symbol.
  const quietZone = 10;

  let cursor = quietZone;
  let path = "";

  modules.forEach((run, index) => {
    // Even indices are bars, odd are spaces. Only the bars are drawn.
    if (index % 2 === 0) {
      path += `M${cursor} 0h${run}v${heightModules}h-${run}z`;
    }

    cursor += run;
  });

  return { path, width: cursor + quietZone, height: heightModules };
}
