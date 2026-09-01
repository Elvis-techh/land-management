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
 * "cuota 7 de 24" is an answer.
 *
 * Deliberately just the position. `appliedTo` also carries `settled`, and this
 * line used to mark an unfinished cuota "(parcial)" and print the lot's own
 * `saldo antes → después` beside it — accurate, and more than the line could
 * carry. What a customer wants from a receipt is how far through the schedule
 * they are; how much is left is the boxed figure at the bottom, and the size of
 * a cuota is that figure over the cuotas still to come. The extra clauses were
 * qualifying an answer nobody had asked for yet.
 *
 * The consequence, stated because it is a real one: on a receipt covering
 * several lots, the per-lot balances are no longer on the paper. The summary's
 * "Balance Anterior" and "Nuevo Balance Pendiente" are the total across the
 * lots on the receipt, so a three-lot customer reads one combined figure rather
 * than three. Every per-lot balance is still derived and still on the screen —
 * see the Contratos tab — it just is not printed here.
 */
function appliedLabel(line: ReceiptLine): string | null {
  if (line.appliedTo.length === 0) {
    return null;
  }

  const numbers = line.appliedTo.map((installment) => String(installment.number));

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
 * "Identidad 0801-1985-04412 · Tel 9982-4471", with whichever half is missing
 * left out entirely — and `null` when neither is known.
 *
 * A label with nothing after it is worse than no label: "Identidad ·  Tel" on a
 * printed document reads as a system that lost the data rather than a customer
 * who never gave it, and it is the kind of thing somebody rings the office
 * about. The identidad is optional — it is confidential, and plenty of buyers
 * never hand it over — so this is the ordinary case rather than a repair for
 * bad data.
 */
function clientDetail(customer: Receipt["customer"]): string | null {
  const identification = customer.identification?.trim() ?? "";
  const phone = customer.phone.trim();

  const parts = [
    identification ? `Identidad ${identification}` : null,
    phone ? `Tel ${formatPhone(phone)}` : null,
  ].filter((part): part is string => part !== null);

  return parts.length > 0 ? parts.join(" · ") : null;
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
 * The constants below are MEASURED, in Chrome, by printing the real document to
 * PDF and bisecting for the largest base that still comes back as one page.
 * They are not guesses and they are not safe to nudge: the reading region
 * (CLIENTE down to the summary) is set a step larger than the rest of the
 * document, so a change to the vertical rhythm in the stylesheet moves them.
 * Re-measure rather than adjust.
 *
 *     content@10pt ≈ 940px fixed  (letterhead, cliente box, table head,
 *                                  summary, signature, barcode, padding)
 *                  + 68px per lot row
 *                  + 36px for a note
 *                  + 62px for the ANULADO banner
 *
 * `USABLE_PX` is deliberately well short of the page, and it is the same budget
 * `.receipt-paper`'s `min-height: 264mm` uses in the print stylesheet — the two
 * have to agree, because the type is shrunk to fit that box and that box is
 * what puts the footer at the foot of the page. A4 at 96dpi is 1122.5px and the
 * stylesheet asks for a zero page margin, but the print dialog is the one that
 * decides: its own default margins, "fit to printable area", or Letter paper
 * (1056px, not 1122.5) all hand back a smaller box than we asked for. Aiming at
 * the full sheet is correct right up until one of those is true, and then every
 * receipt prints on two pages.
 *
 * What that buys, at these sizes: EIGHT lots is the most that fits inside the
 * safe budget. Nine to eleven still land on one physical A4 sheet but spend the
 * reserve doing it, and past eleven the document spills. The floor is a
 * legibility limit rather than a fitting one — below 6.5pt the reading region
 * stops being readable across a counter, and a second page is the better
 * failure than print nobody can read.
 *
 * The 10pt ceiling is now only a guard. Even a one-lot receipt fills about
 * 1008px at 10pt, so the budget binds first and this rarely comes into play.
 */
const USABLE_PX = 1000;

function printBaseFor(receipt: Receipt): string {
  const estimatedPx =
    940 +
    68 * receipt.lines.length +
    (receipt.note ? 36 : 0) +
    (receipt.voidedAt ? 62 : 0);

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

  const detail = clientDetail(receipt.customer);
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
            when two customers share a name. Dropped, line and all, when there
            is nothing to put in it — see `clientDetail`. */}
        {detail && <div className="receipt-client-detail">{detail}</div>}
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

                  {/* Where the lot sits in its schedule, and nothing else —
                      see `appliedLabel`. A cash sale has no schedule, so the
                      line is dropped entirely rather than left empty. */}
                  {applied && <span className="receipt-item-detail">{applied}</span>}
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
