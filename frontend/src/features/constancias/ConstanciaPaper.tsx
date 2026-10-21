import type { CSSProperties } from "react";

import logoUrl from "../../assets/mr-investments.png";
import { amountInWords, dateInWords } from "../../lib/amountInWords";
import { BUSINESS, CONTACT_LINE } from "../../lib/business";
import type { MoneyView } from "../../lib/money";
import { formatDocumentMoney } from "../../lib/money";
import { paymentTypeLabel } from "../receipts/paymentType";
import type { Constancia } from "./api";

/** Always lempiras: the document states what the contract was worth and was paid. */
const LEMPIRAS: MoneyView = { currency: "HNL", usdRate: 1 };

function money(amount: Constancia["totalPaid"]): string {
  return formatDocumentMoney(amount, LEMPIRAS);
}

/** "13 de octubre de 2026". Parsed as UTC parts, for the reason given in ReceiptPaper. */
function longDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);

  return new Intl.DateTimeFormat("es-HN", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year!, month! - 1, day!)));
}

/**
 * The type size to print this constancia at, so it stays on one sheet however
 * long its payment history is — the same idea as `printBaseFor` on the
 * receipt, and every length in the document is in `em` against it.
 *
 * MEASURED in Chrome by printing to PDF and bisecting for the largest base
 * that is still one A4 page: 11.7pt with 2 payments, 9.2pt with 12, 7.3pt with
 * 24, 6.5pt with 30. Those fit `10 / (0.805 + 0.0242 × payments)`; the 8.8
 * below aims about 12% under that, for the print dialog's own margins and
 * Letter paper, as the receipt does. From about 25 payments the floor binds;
 * past about 30 the history runs onto a second sheet — 6.5pt is the smallest
 * the receipt allows too, and a second page beats print nobody can read.
 */
function printBaseFor(constancia: Constancia): string {
  const points = 8.8 / (0.805 + 0.0242 * constancia.payments.length);

  return `${Math.max(6.5, Math.min(10, points)).toFixed(2)}pt`;
}

/** "20/10/2026": the history is a column of dates, and long ones wrap on a phone. */
function shortDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");

  return `${day}/${month}/${year}`;
}

/**
 * The «Constancia de Cancelación Total»: a letter, not a receipt, saying that
 * one contract has been paid in full — the paper a customer takes to the
 * notary for the escritura.
 *
 * It speaks for THIS contract only, not for everything the customer holds, and
 * it carries the contract's whole payment history, because that is the first
 * thing a notary asks for. The letterhead, signature and paper are the
 * receipt's (`.receipt-*`), so the two documents read as coming from the same
 * office.
 *
 * A voided one still renders, with ANULADA across it and no «saldo cancelado»
 * seal: it is what the office sees when somebody reads them a code from a
 * constancia that is no longer true.
 */
export function ConstanciaPaper({ constancia }: { constancia: Constancia }) {
  const { customer, contract, lot } = constancia;
  const isVoid = constancia.voidedAt !== null;
  const identification = customer.identification?.trim();

  return (
    <div
      className={`receipt-paper constancia-paper${isVoid ? " is-void" : ""}`}
      // Read by the print stylesheet only, as on the receipt.
      style={{ "--receipt-print-size": printBaseFor(constancia) } as CSSProperties}
    >
      {isVoid && (
        <p className="receipt-void-banner">ANULADA — {constancia.voidReason}</p>
      )}

      <header className="receipt-header">
        <div className="receipt-logo">
          <img src={logoUrl} alt={BUSINESS.name} />
          <h2>{BUSINESS.name}</h2>
        </div>

        <div className="receipt-meta">
          <p>
            <span className="receipt-label">CONSTANCIA N.º</span> {constancia.code}
          </p>
          <p>
            <span className="receipt-label">FECHA:</span> {longDate(constancia.issuedOn)}
          </p>
          <p>
            <span className="receipt-label">CONTRATO:</span> {contract.code}
          </p>
        </div>
      </header>

      <h1 className="constancia-title">Constancia de Cancelación Total</h1>
      <p className="constancia-subtitle">
        Lote {lot.code} · {lot.projectName}
      </p>

      <p className="constancia-body">
        Por medio de la presente, <strong>{BUSINESS.name}</strong> hace constar que{" "}
        <strong>{customer.fullName}</strong>
        {identification ? `, con identidad ${identification},` : ""} ha cancelado en su
        totalidad el valor de{" "}
        <strong>
          {amountInWords(contract.salePrice)}{" "}
          <span className="constancia-figure">({money(contract.salePrice)})</span>
        </strong>{" "}
        correspondiente al <strong>Lote {lot.code} del {lot.projectName}</strong>, según contrato{" "}
        {contract.code}
        {constancia.lastPaidOn ? `, siendo su último pago el ${longDate(constancia.lastPaidOn)}` : ""}.
        A la fecha, dicho contrato no presenta saldo pendiente.
      </p>

      <div className="constancia-history">
        <h4 className="receipt-label">Historial de pagos de este contrato</h4>
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Concepto</th>
              <th>Recibo</th>
              <th className="receipt-right">Monto</th>
            </tr>
          </thead>
          <tbody>
            {constancia.payments.map((payment, index) => (
              <tr key={index}>
                <td>{shortDate(payment.paidOn)}</td>
                <td>{paymentTypeLabel(payment.type)}</td>
                <td>{payment.receiptCode ?? "—"}</td>
                <td className="receipt-right">{money(payment.amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>Total pagado · Valor del contrato {money(contract.salePrice)}</td>
              <td className="receipt-right">{money(constancia.totalPaid)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="constancia-body">
        Se extiende la presente a solicitud del interesado en {BUSINESS.location},{" "}
        {dateInWords(constancia.issuedOn)}.
      </p>

      {!isVoid && (
        <div className="constancia-seal-row">
          <span className="constancia-seal">SALDO CANCELADO</span>
        </div>
      )}

      <footer className="receipt-footer">
        <div className="receipt-signature">
          <p className="receipt-signature-name">{BUSINESS.signatory}</p>
          <hr />
          <p className="receipt-signature-label">Firma Autorizada</p>
        </div>

        <p className="receipt-contact">{CONTACT_LINE}</p>

        <p className="receipt-stamp">
          Para verificar esta constancia, comuníquese con {BUSINESS.name} y dé el código{" "}
          <strong>{constancia.lookupCode}</strong>.
        </p>
      </footer>
    </div>
  );
}
