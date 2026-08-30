import type { MoneyView } from "../../lib/money";
import { formatMoney } from "../../lib/money";
import { formatPhone } from "../../lib/phone";
import type { Receipt } from "../../types";
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
 * The document itself — what gets printed and handed to the customer.
 *
 * Every figure on it is derived by the server on read. There is no "lock" here
 * and nothing to freeze: the receipt shows what was true at its own position in
 * the ledger, and it will still show that after a payment from two months ago
 * is corrected, because the correction moves the ledger and the ledger is what
 * this is rendered from.
 *
 * The three figures a customer actually reads — saldo anterior, lo que entregó,
 * saldo nuevo — are laid out so the subtraction is visible on the page. If they
 * do not add up in front of them, they will not believe any of it.
 */
export function ReceiptPaper({ receipt, money }: ReceiptPaperProps) {
  const isMultiLot = receipt.lines.length > 1;

  return (
    <div className={`receipt-paper${receipt.voidedAt ? " is-void" : ""}`}>
      <div className="receipt-brand">
        <span className="name">Lindero</span>
        <span className="id">{receipt.code}</span>
      </div>

      {receipt.voidedAt && (
        // Stated on the document rather than only in the list, because this
        // sheet is the thing that gets printed, photographed and forwarded.
        <p className="receipt-void-banner">
          ANULADO — {receipt.voidReason}
        </p>
      )}

      <div className="receipt-line">
        <span>Cliente</span>
        <span>{receipt.customer.fullName}</span>
      </div>
      <div className="receipt-line">
        <span>Identidad</span>
        <span>{receipt.customer.identification}</span>
      </div>
      <div className="receipt-line">
        <span>Teléfono</span>
        <span>{formatPhone(receipt.customer.phone)}</span>
      </div>
      <div className="receipt-line">
        <span>Fecha</span>
        <span>{longDate(receipt.issuedOn)}</span>
      </div>
      {receipt.method && (
        <div className="receipt-line">
          <span>Forma de pago</span>
          <span>{METHOD_LABELS[receipt.method] ?? receipt.method}</span>
        </div>
      )}

      {/* One line per lot. A customer who bought three lots hands over one
          amount, and each lot keeps its own balance — a merged total would
          hide which lot the money actually moved. */}
      <p className="receipt-section-label">
        {isMultiLot ? `${receipt.lines.length} lotes` : "Lote"}
      </p>

      {receipt.lines.map((line) => (
        <div key={line.paymentId} className="receipt-lot">
          <div className="receipt-line">
            <span>
              {line.lotCode ?? "—"}
              {line.projectName ? ` · ${line.projectName}` : ""}
            </span>
            <span>{formatMoney(line.amount, money)}</span>
          </div>

          {line.appliedTo.length > 0 && (
            // What the money was applied to. Disputed far more often than how
            // much of it there was.
            <p className="receipt-applied">
              {line.appliedTo
                .map(
                  (installment) =>
                    `cuota ${installment.number}${installment.settled ? "" : " (parcial)"}`,
                )
                .join(", ")}
            </p>
          )}

          {isMultiLot && (
            <p className="receipt-applied">
              saldo {formatMoney(line.previousBalance, money)} →{" "}
              {formatMoney(line.newBalance, money)}
            </p>
          )}
        </div>
      ))}

      <div className="receipt-total">
        <span>Total recibido</span>
        <span>{formatMoney(receipt.totalPaid, money)}</span>
      </div>

      <div className="receipt-balances">
        <div className="receipt-line">
          <span>Saldo anterior</span>
          <span>{formatMoney(receipt.previousBalance, money)}</span>
        </div>
        <div className="receipt-line">
          <span>Saldo nuevo</span>
          <span>{formatMoney(receipt.newBalance, money)}</span>
        </div>
        <div className="receipt-line">
          <span>Pagado acumulado</span>
          <span>{formatMoney(receipt.cumulativePaid, money)}</span>
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

      <p className="receipt-stamp">
        Recibido por {receipt.issuedBy.name} · código de consulta{" "}
        <strong>{receipt.lookupCode}</strong>
      </p>
    </div>
  );
}
