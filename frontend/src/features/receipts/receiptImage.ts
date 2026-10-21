/**
 * The receipt, as a PNG somebody can send.
 *
 * A customer asks for their receipt on WhatsApp, and what they want is the
 * document — the letterhead, the lot, the cuota, the boxed balance and the
 * signature — not a paragraph describing it. So this rasterises the very same
 * `ReceiptPaper` the screen and the printer render. There is no second layout
 * and no template to keep in step: what is sent is what was printed, because it
 * is the same markup and the same stylesheet.
 *
 * `html-to-image` does the rendering, and it is the one runtime dependency this
 * app has taken beyond React. The reason it is not written here, when the Code
 * 128 encoder next door WAS: that encoder is a table and eighty lines of
 * arithmetic with a right answer that never changes. This is the opposite —
 * cloning a subtree with every computed style resolved, inlining images as data
 * URIs, and re-fetching cross-origin stylesheets that CSSOM refuses to read,
 * across browsers that each get it wrong differently. Getting it subtly wrong
 * produces a plausible-looking document with a figure missing, handed to a
 * customer. That is not a bounded problem, and it is not one worth owning.
 *
 * How it works, since the mechanism is not obvious: the node is cloned into an
 * SVG `<foreignObject>`, which the browser then renders with its own engine and
 * draws onto a canvas. The clone is a separate document — it inherits nothing
 * from the page — which is why every style has to be copied onto it inline and
 * every font and image embedded. Anything left referenced by URL is simply
 * absent from the picture.
 */

import { toBlob } from "html-to-image";

/**
 * Twice the CSS pixels, so the image survives being opened and pinched.
 *
 * WhatsApp re-compresses what it sends, and a phone screen is 2–3× denser than
 * the pixels this is laid out in. At 1× the amounts are legible on a desktop
 * and mush on a handset, which is where every one of these will be read.
 * Beyond 2× the file grows faster than the legibility does.
 */
const PIXEL_RATIO = 2;

/**
 * The signature's font, base64'd into an @font-face the clone can use.
 *
 * Only one webfont shows up on the paper — 'Dancing Script', the signature
 * above "Firma Autorizada"; the rest of the receipt is deliberately
 * Helvetica/Arial. It is worth the trouble because the alternative is a
 * signature in whatever cursive face the reader's phone happens to own, on the
 * one part of the page that is meant to look like a person signed it.
 *
 * The font ships with the app (@fontsource, imported in main.tsx) and this
 * reads the same file. It used to come from `getFontEmbedCSS`, which walked
 * every stylesheet down to the Google Fonts one and downloaded it all again
 * while the image was drawn. On a phone's data that failed now and then, the
 * failure was kept for the life of the page, and every image from then on was
 * signed in the phone's own cursive while the preview still showed the real
 * one. Our own server, one small file, no Google: the preview and the image
 * now draw from the same copy.
 *
 * Latin only: it holds every letter of a Spanish name, accents and ñ included.
 */
const SIGNATURE_FONT_FACE = (dataUrl: string) =>
  `@font-face{font-family:'Dancing Script';font-style:normal;font-weight:700;` +
  `src:url(${dataUrl}) format('woff2');}`;

/**
 * Cached as the PROMISE, so two receipts drawn at once share one download. A
 * failure is NOT kept: the next image tries again, rather than every image
 * until a reload going out with the wrong signature.
 */
let fontCssPromise: Promise<string> | null = null;

function embeddedFontCss(): Promise<string> {
  // Its address is looked up here rather than imported at the top, so the
  // unit tests, which load this file in Node, never meet a font file.
  fontCssPromise ??= import("@fontsource/dancing-script/files/dancing-script-latin-700-normal.woff2?url")
    .then(({ default: url }) => fetch(url))
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return response.blob();
    })
    .then(
      (blob) =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();

          reader.onload = () => resolve(SIGNATURE_FONT_FACE(String(reader.result)));
          reader.onerror = () => reject(reader.error ?? new Error("No se pudo leer la fuente."));
          reader.readAsDataURL(new Blob([blob], { type: "font/woff2" }));
        }),
    )
    .catch(() => {
      // A receipt with a fallback signature beats no receipt; try again next time.
      fontCssPromise = null;

      return "";
    });

  return fontCssPromise;
}

/**
 * Wait until every picture on the receipt — the logo — has arrived.
 *
 * The image is drawn the moment a receipt is opened, and the first time that
 * happens the logo is usually still downloading. An `<img>` that has not loaded
 * is laid out zero pixels tall, and the renderer copies that height onto its
 * clone, so the PNG came out with no logo while the preview and the printout,
 * drawn later, had it. A picture that fails to load is let go: a receipt
 * without a logo beats no receipt.
 */
function imagesLoaded(node: HTMLElement): Promise<unknown> {
  return Promise.all(
    Array.from(node.querySelectorAll("img"), (img) => img.decode().catch(() => undefined)),
  );
}

/**
 * Render a receipt to a PNG file, named after the receipt.
 *
 * Takes the offscreen STAGE — `.receipt-share-stage` — rather than the preview
 * in the sidebar. The preview is 320px in a column and its container queries
 * fold it into a narrow strip; the stage is laid out at A4, which is what a
 * receipt is supposed to look like.
 */
export async function receiptToPng(stage: HTMLElement, receiptCode: string): Promise<File> {
  /*
   * The paper INSIDE the stage, not the stage itself. This is not tidiness.
   *
   * The stage is parked offscreen with `position: fixed; left: -10000px`, and
   * the renderer copies the computed styles of whatever it is given onto the
   * clone it puts in the `<foreignObject>` — position and offset included.
   * Handed the stage, it faithfully reproduces a fixed box positioned ten
   * thousand pixels to the left of the picture, and returns a correctly sized,
   * perfectly blank sheet of A4. Handed the paper, whose own position is
   * `static`, it draws the document.
   */
  const node = stage.querySelector<HTMLElement>(".receipt-paper");

  if (node === null) {
    throw new Error("No hay un recibo que convertir en imagen.");
  }

  const blob = await paperToPngBlob(node);

  // The filename is what the customer sees when they save it, and what somebody
  // in the office sees if it is forwarded back to them.
  return new File([blob], `Recibo ${receiptCode}.png`, { type: "image/png" });
}

/**
 * One sheet of paper — a `.receipt-paper` laid out in an offscreen stage — as
 * a PNG. Shared by the receipt above and the constancia's PDF, which draws
 * each of its sheets this way. See `receiptToPng` for why the node must be
 * the paper and not the stage around it.
 */
export async function paperToPngBlob(node: HTMLElement): Promise<Blob> {
  await imagesLoaded(node);

  const blob = await toBlob(node, {
    pixelRatio: PIXEL_RATIO,
    // The paper is white because the document says so, but `toBlob` renders a
    // TRANSPARENT background otherwise — and a transparent PNG on WhatsApp's
    // dark theme is black text on black.
    backgroundColor: "#FFFFFF",
    // Measured from the laid-out node rather than assumed: a receipt with eight
    // lots is taller than one with a single lot.
    width: node.offsetWidth,
    height: node.offsetHeight,
    skipFonts: true,
    fontEmbedCSS: await embeddedFontCss(),
  });

  if (blob === null) {
    throw new Error("No se pudo generar la imagen del documento.");
  }

  return blob;
}
