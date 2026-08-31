import type { CSSProperties } from "react";

import logoUrl from "../../assets/mr-investments.png";
import { BUSINESS, CONTACT_LINE, THANK_YOU } from "../../lib/business";
import { code128Geometry } from "../../lib/code128";
import type { MoneyView } from "../../lib/money";
import { cents, formatDocumentMoney } from "../../lib/money";
import { formatPhone } from "../../lib/phone";
import type { Receipt, ReceiptLine } from "../../types";
import { attachmentUrl } from "./api";

interface ReceiptPaperProps {
  receipt: Receipt;
  money: MoneyView;
}

const METHOD_LABELS: Record<string, string> = {
  cash: "Efectivo",
  transfer: "Transferencia",
  card: "Tarjeta",
};

/** "15 de marzo de 2026" — a date on a document is written out, not abbreviated. */
function longDate(isoDate: string): string {
  // Parsed as UTC parts rather than through `new Date(iso)`, which reads a bare
  // date as midnight UTC and then renders it in local time — one timezone west
  // of Greenwich and the receipt is dated the day before.
  const [year, month, day] = isoDate.split("-").map(Number);
  const formatter = new Intl.DateTimeFormat("es-HN", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return formatter.format(new Date(Date.UTC(year!, month! - 1, day!)));
}

/**
 * "cuota 7 de 24", or "cuotas 7 y 8 de 24" when one payment covered two.
 *
 * The single most useful line on the document: "recibí L 5,000" is a number,
 * "cuota 7 de 24" is an answer. A partial cuota says so, because a customer who
 * reads "cuota 7" and has not finished paying it will believe they have.
 */
function appliedLabel(line: ReceiptLine): string | null {
  if (line.appliedTo.length === 0) {
    return null;
  }

  const numbers = line.appliedTo.map(
    (installment) => `${installment.number}${installment.settled ? "" : " (parcial)"}`,
  );

  const word = numbers.length === 1 ? "cuota" : "cuotas";
  const list =
    numbers.length === 1
      ? numbers[0]!
      : `${numbers.slice(0, -1).join(", ")} y ${numbers[numbers.length - 1]!}`;

  // "de 24" only when we know the total. A cash sale has no schedule, and
  // "cuota 3 de 0" is worse than saying nothing.
  const total = line.installmentCount > 0 ? ` de ${line.installmentCount}` : "";

  return `${word} ${list}${total}`;
}

/**
 * The type size to print this particular receipt at, so that all of it lands on
 * one sheet of A4.
 *
 * A receipt is one page. A signature and a barcode alone on a second sheet is
 * not a longer receipt, it is a broken one — and the customer is handed both.
 * So rather than pick a size that suits the common single-lot receipt and let
 * the eight-lot one spill, the size is chosen per receipt: the more there is to
 * fit, the smaller the base, and because every length in the layout is in `em`
 * against that base, the whole document shrinks together — margins, logo,
 * signature and all.
 *
 * The constants are measured, not guessed. At a 10pt base the document is about
 * 844px of fixed furniture (letterhead, cliente box, summary, footer) plus 58px
 * per lot row, plus about 48px each for a note and for the ANULADO banner. If
 * the vertical rhythm in the stylesheet is ever changed, re-measure these three
 * numbers rather than nudging them.
 *
 * `USABLE_PX` is deliberately well short of the page. A4 at 96dpi is 1122.5px,
 * and the stylesheet asks for a zero page margin — but the print dialog is the
 * one that decides, and it may hand back a smaller box than we asked for: its
 * own default margins, "fit to printable area", or simply Letter paper instead
 * of A4. An estimate aimed at the full sheet is correct right up until one of
 * those is true, and then every receipt prints on two pages. 1000px is about
 * 264mm, which survives roughly 33mm of margin the dialog never told us about.
 *
 * The floor is a legibility limit, not a fitting one: past roughly a dozen lots
 * on a single receipt this returns 6.5pt and the document may spill onto a
 * second page, which is the better failure than print nobody can read.
 */
const USABLE_PX = 1000;

function printBaseFor(receipt: Receipt): string {
  const extras = (receipt.note ? 1 : 0) + (receipt.voidedAt ? 1 : 0);
  const estimatedPx = 844 + 58 * receipt.lines.length + 48 * extras;
  const points = (10 * USABLE_PX) / estimatedPx;

  return `${Math.max(6.5, Math.min(10, points)).toFixed(2)}pt`;
}

/**
 * The document itself — what gets printed and handed to the customer.
 *
 * The layout is the official receipt, ported from the Puppeteer template in
 * `inversion_pdf_service/server.js`: the same header, the same CLIENTE box, the
 * same two-column DESCRIPCIÓN / MONTO PAGADO table, the same four summary
 * figures with the new balance boxed in red, and the same signed footer. That
 * service existed because Airtable could not render HTML and needed somebody
 * to do it for them. This app renders its own, so the layout lives here and the
 * network round trip is gone.
 *
 * What is NOT from the template is everything Airtable never had: the
 * customer's identidad, which cuotas the money covered, the per-lot balances on
 * a multi-lot receipt, the ANULADO banner, and the código de consulta. Those
 * are fitted into the official design rather than bolted beside it.
 *
 * Every figure is derived by the server on read. There is no "lock" here and
 * nothing to freeze: the receipt shows what was true at its own position in the
 * ledger, and it will still show that after a payment from two months ago is
 * corrected, because the correction moves the ledger and the ledger is what
 * this is rendered from.
 */
export function ReceiptPaper({ receipt, money }: ReceiptPaperProps) {
  const isMultiLot = receipt.lines.length > 1;

  /*
   * "Valor Total del Contrato" — summed across the lots ON THIS RECEIPT.
   *
   * Deliberately the same scope as `previousBalance` and `newBalance`, which
   * `receiptFigures` accumulates only over the contracts this receipt touches.
   * Summing every contract the customer holds would put a figure on the page
   * that the balances beside it do not describe.
   */
  const contractTotal = cents(
    receipt.lines.reduce((total, line) => total + line.contractTotal, 0),
  );

  const barcode = code128Geometry(receipt.code);

  return (
    <div
      className={`receipt-paper${receipt.voidedAt ? " is-void" : ""}`}
      // Read by the print stylesheet. Ignored on screen, where the receipt is a
      // preview in a fixed column rather than a page that has to be filled.
      style={{ "--receipt-print-size": printBaseFor(receipt) } as CSSProperties}
    >
      {receipt.voidedAt && (
        // Stated on the document rather than only in the list, because this
        // sheet is the thing that gets printed, photographed and forwarded. A
        // voided receipt that prints as though it were valid is the one bug on
        // this page that costs real money.
        <p className="receipt-void-banner">ANULADO — {receipt.voidReason}</p>
      )}

      <header className="receipt-header">
        <div className="receipt-logo">
          <img src={logoUrl} alt={BUSINESS.name} />
          <h2>{BUSINESS.name}</h2>
        </div>

        <div className="receipt-meta">
          <h1>RECIBO DE PAGO</h1>
          <p>
            <span className="receipt-label">RECIBO #</span> {receipt.code}
          </p>
          <p>
            <span className="receipt-label">FECHA:</span> {longDate(receipt.issuedOn)}
          </p>
          {receipt.method && (
            <p>
              <span className="receipt-label">MÉTODO DE PAGO:</span>{" "}
              {METHOD_LABELS[receipt.method] ?? receipt.method}
            </p>
          )}
        </div>
      </header>

      <div className="receipt-client">
        <span className="receipt-label">CLIENTE</span>
        <div className="receipt-client-name">{receipt.customer.fullName}</div>
        {/* Not on the original, which took its names from Airtable and had
            nothing else. An identidad is how a receipt is matched to a person
            when two customers share a name. */}
        <div className="receipt-client-detail">
          Identidad {receipt.customer.identification} · Tel{" "}
          {formatPhone(receipt.customer.phone)}
        </div>
      </div>

      {/* One row per lot. A customer who bought three lots hands over one
          amount, and each lot keeps its own balance — a merged total would
          hide which lot the money actually moved. */}
      <table className="receipt-items">
        <thead>
          <tr>
            <th>DESCRIPCIÓN / LOTE</th>
            <th className="receipt-right">MONTO PAGADO</th>
          </tr>
        </thead>
        <tbody>
          {receipt.lines.map((line) => {
            const applied = appliedLabel(line);

            return (
              <tr key={line.paymentId}>
                <td>
                  <span className="receipt-item-lot">
                    {line.lotCode ?? "—"}
                    {line.projectName ? ` · ${line.projectName}` : ""}
                  </span>

                  {/* One line, not two. Each lot on a multi-lot receipt would
                      otherwise cost three rows of vertical space, and three
                      lots is enough to push the signature onto a second page. */}
                  {(applied || isMultiLot) && (
                    <span className="receipt-item-detail">
                      {applied}
                      {applied && isMultiLot ? " · " : ""}
                      {isMultiLot &&
                        // Only when there is more than one, because with a
                        // single lot these are the same two figures as the
                        // summary below.
                        `saldo ${formatDocumentMoney(line.previousBalance, money)} → ${formatDocumentMoney(line.newBalance, money)}`}
                    </span>
                  )}
                </td>
                <td className="receipt-right">{formatDocumentMoney(line.amount, money)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="receipt-summary">
        <div className="receipt-summary-col">
          <div className="receipt-summary-row">
            <span>Valor Total del Contrato</span>
            <span className="receipt-summary-value">{formatDocumentMoney(contractTotal, money)}</span>
          </div>
          <div className="receipt-summary-row">
            <span>Total Pagado Acumulado</span>
            <span className="receipt-summary-value">
              {formatDocumentMoney(receipt.cumulativePaid, money)}
            </span>
          </div>
        </div>

        <div className="receipt-summary-col">
          <div className="receipt-summary-row">
            <span>Balance Anterior Total</span>
            <span className="receipt-summary-value">
              {formatDocumentMoney(receipt.previousBalance, money)}
            </span>
          </div>
          <div className="receipt-summary-row is-bold">
            <span>Total Pagado Hoy</span>
            <span>{formatDocumentMoney(receipt.totalPaid, money)}</span>
          </div>

          {/* The figure the customer came to read. Boxed and red on the
              original, and kept that way: the three numbers above it are the
              working, and this is the answer. */}
          <div className="receipt-highlight">
            <span className="receipt-highlight-label">Nuevo Balance Pendiente</span>
            <span className="receipt-highlight-value">
              {formatDocumentMoney(receipt.newBalance, money)}
            </span>
          </div>
        </div>
      </div>

      {receipt.note && <p className="receipt-note">{receipt.note}</p>}

      {receipt.attachments.length > 0 && (
        // The customer's own evidence, kept beside the payment it belongs to.
        // Hidden when printing: the receipt is what gets handed over, and the
        // deposit slip is already the customer's.
        <div className="receipt-proofs">
          <p className="receipt-section-label">Comprobante del cliente</p>

          {receipt.attachments.map((file) => (
            <a
              key={file.id}
              className="receipt-proof"
              href={attachmentUrl(file.id)}
              target="_blank"
              rel="noreferrer"
            >
              {file.contentType.startsWith("image/") ? (
                <img src={attachmentUrl(file.id)} alt={file.fileName} loading="lazy" />
              ) : (
                <span className="proof-thumb proof-thumb-pdf">PDF</span>
              )}
              <span className="receipt-proof-name">{file.fileName}</span>
            </a>
          ))}
        </div>
      )}

      <footer className="receipt-footer">
        <div className="receipt-signature">
          <p className="receipt-signature-name">{BUSINESS.signatory}</p>
          <hr />
          <p className="receipt-signature-label">Firma Autorizada</p>
        </div>

        <p className="receipt-thanks">{THANK_YOU}</p>
        <p className="receipt-contact">{CONTACT_LINE}</p>

        {/*
         * The receipt number, scannable. Encoded from `code` rather than
         * `lookupCode` so that what a scanner reads is what is printed as
         * "RECIBO #" at the top of the page — a barcode that disagrees with the
         * number beside it is worse than no barcode.
         *
         * Generated here rather than fetched: see lib/code128.ts.
         */}
        <svg
          className="receipt-barcode"
          viewBox={`0 0 ${barcode.width} ${barcode.height}`}
          preserveAspectRatio="none"
          shapeRendering="crispEdges"
          role="img"
          aria-label={`Código de barras del recibo ${receipt.code}`}
        >
          <path d={barcode.path} fill="#000000" />
        </svg>

        <p className="receipt-stamp">
          Recibido por {receipt.issuedBy.name} · código de consulta{" "}
          <strong>{receipt.lookupCode}</strong>
        </p>
      </footer>
    </div>
  );
}
