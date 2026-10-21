/**
 * Sending a constancia over WhatsApp, as a PDF.
 *
 * A PDF rather than the picture a receipt is sent as, because a constancia is
 * a legal document of several sheets — the letter and its annex — that the
 * customer forwards to a notary or prints. One file holds every page, in order,
 * exactly as the printer gets them.
 *
 * The sheets are drawn the receipt's way (see receiptImage.ts): the same
 * `ConstanciaPaper`, laid out at A4 in an offscreen stage, each sheet
 * rasterised and placed on a page of its own. There is no second layout to
 * keep in step with the printed one.
 *
 * Delivering it is a choice between two imperfect routes, for the reasons
 * whatsapp.ts sets out at length: a `wa.me` link opens the right chat but
 * cannot carry a file, and the share sheet carries the file but makes somebody
 * pick the chat. The clipboard route receipts prefer does not exist for a PDF
 * — no clipboard takes one. So:
 *
 *  - On a phone, the share sheet, with the message as its text. WhatsApp is
 *    one tap in it, and the chat is picked by hand.
 *  - On a computer, the customer's chat opens with the message already typed,
 *    and the PDF is saved, to be attached with WhatsApp's clip. A download is
 *    what receipts avoid, but there is no other way to put a PDF in a desktop
 *    chat, and a constancia is issued once per sale rather than every month.
 */

import { formatPhone } from "../../lib/phone";
import { paperToPngBlob } from "../receipts/receiptImage";
import { chatUrl, isTouchDevice } from "../receipts/whatsapp";
import type { Constancia } from "./api";
import { joinSpanish, lotsPhrase } from "./constanciaLayout";

/**
 * The lots, as the message names them: «del Lote B-12 del Proyecto Santiago»,
 * or «de sus 2 lotes: B-12 y B-13 del Proyecto Santiago». Not `lotsPhrase`
 * after a «del», which would say «del Lotes B-12 y B-13».
 */
function whichLots(parts: Constancia["parts"]): string {
  if (parts.length === 1) {
    return `del ${lotsPhrase(parts)}`;
  }

  const projects = new Set(parts.map((part) => part.lot.projectName));
  const list =
    projects.size === 1
      ? `${joinSpanish(parts.map((part) => part.lot.code))} del ${parts[0]!.lot.projectName}`
      : joinSpanish(parts.map((part) => `${part.lot.code} del ${part.lot.projectName}`));

  return `de sus ${parts.length} lotes: ${list}`;
}

/** What the customer reads under the file. */
export function constanciaCaption(constancia: Constancia): string {
  return (
    `Adjunto su *Constancia de Cancelación Total* ${whichLots(constancia.parts)}. ` +
    `Para verificarla, comuníquese con nosotros y dé el código *${constancia.lookupCode}*. ` +
    "Cualquier duda me deja saber."
  );
}

/** A4 in millimetres, which is what jsPDF measures in. */
const PAGE_WIDTH_MM = 210;
const PAGE_HEIGHT_MM = 297;

/**
 * Every sheet in the stage — the letter, then the annex sheets — as one PDF.
 *
 * jsPDF is loaded here, on demand, rather than with the app: it is the size of
 * a small app on its own, and it is needed once per sale.
 */
export async function constanciaToPdf(stage: HTMLElement, constancia: Constancia): Promise<File> {
  const sheets = Array.from(stage.querySelectorAll<HTMLElement>(".receipt-paper"));

  if (sheets.length === 0) {
    throw new Error("No hay una constancia que convertir en PDF.");
  }

  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress: true });

  pdf.setProperties({
    title: `Constancia ${constancia.code}`,
    subject: `Constancia de Cancelación Total · ${constancia.customer.fullName}`,
  });

  for (const [index, sheet] of sheets.entries()) {
    const image = new Uint8Array(await (await paperToPngBlob(sheet)).arrayBuffer());
    // Full width. A sheet is laid out at A4's proportions, so it fills the
    // page; one that ran a little long is shrunk to the page's height, and
    // centred, rather than cut off at the foot.
    const ratio = sheet.offsetHeight / sheet.offsetWidth;
    const fitsWidth = ratio * PAGE_WIDTH_MM <= PAGE_HEIGHT_MM;
    const width = fitsWidth ? PAGE_WIDTH_MM : PAGE_HEIGHT_MM / ratio;
    const height = fitsWidth ? ratio * PAGE_WIDTH_MM : PAGE_HEIGHT_MM;

    if (index > 0) {
      pdf.addPage();
    }

    pdf.addImage(image, "PNG", (PAGE_WIDTH_MM - width) / 2, 0, width, height);
  }

  return new File([pdf.output("blob")], `Constancia ${constancia.code}.pdf`, {
    type: "application/pdf",
  });
}

/** Where a constancia got to, so the dialog can say what to do next. */
export type ConstanciaShareOutcome =
  /** Handed to the share sheet. */
  | { status: "shared" }
  /** They backed out of the share sheet. */
  | { status: "cancelled" }
  /** Saved, and the customer's chat opened: attach it there. */
  | { status: "saved"; fileName: string; chatUrl: string; phone: string };

/** Save a file the ordinary way, through a temporary link. */
function save(file: File) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");

  link.href = url;
  link.download = file.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Long enough for the browser to have started the download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Send the PDF. MUST be called from a click handler with the file already in
 * hand: the share sheet and `window.open` both need the browser to still
 * believe it is inside the click.
 */
export async function sendConstanciaOnWhatsApp(
  file: File,
  caption: string,
  phone: string,
): Promise<ConstanciaShareOutcome> {
  if (isTouchDevice() && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text: caption });

      return { status: "shared" };
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        return { status: "cancelled" };
      }
      // Anything else falls through to saving it, rather than dead-ending.
    }
  }

  const url = chatUrl(phone, caption);

  window.open(url, "_blank", "noopener,noreferrer");
  save(file);

  return { status: "saved", fileName: file.name, chatUrl: url, phone: formatPhone(phone) };
}
