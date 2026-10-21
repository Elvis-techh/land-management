import logoUrl from "../../assets/mr-investments.png";
import { amountInWords, dateInWords } from "../../lib/amountInWords";
import { BUSINESS, CONTACT_LINE } from "../../lib/business";
import type { MoneyView } from "../../lib/money";
import { formatDocumentMoney } from "../../lib/money";
import { paymentTypeLabel } from "../receipts/paymentType";
import type { Constancia } from "./api";
import {
  ANNEX_ROWS_PER_PAGE,
  annexPages,
  annexRows,
  joinSpanish,
  lotsPhrase,
  summarizePayments,
} from "./constanciaLayout";

/** Always lempiras: the document states what the contracts were worth and were paid. */
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

/** "20/10/2026": the history is a column of dates, and long ones wrap on a phone. */
function shortDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");

  return `${day}/${month}/${year}`;
}

/** "1 pago", "58 pagos". */
function payments(count: number): string {
  return count === 1 ? "1 pago" : `${count} pagos`;
}

/** The letterhead every sheet carries, so a loose annex page still says whose it is. */
function Letterhead({ constancia }: { constancia: Constancia }) {
  const codes = constancia.parts.map((part) => part.contract.code);

  return (
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
          <span className="receipt-label">{codes.length === 1 ? "CONTRATO:" : "CONTRATOS:"}</span>{" "}
          {codes.join(", ")}
        </p>
      </div>
    </header>
  );
}

/** The period a set of payments ran over: "15/01/2021" or "15/02/2021 al 15/12/2025". */
function period(firstOn: string, lastOn: string): string {
  return firstOn === lastOn ? shortDate(firstOn) : `${shortDate(firstOn)} al ${shortDate(lastOn)}`;
}

interface ConstanciaPaperProps {
  constancia: Constancia;
  /** Print the full payment history on annex sheets after the letter. */
  withAnnex: boolean;
}

/**
 * The «Constancia de Cancelación Total»: a letter, not a receipt, saying that
 * a contract has been paid in full — or, combined, several of the same
 * customer's — the paper taken to the notary for the escritura.
 *
 * TWO parts, because most contracts here run to dozens of cuotas:
 *
 * - The letter, always one sheet at the document's full size. It states the
 *   fact and summarises rather than lists: for one contract, its payments by
 *   kind («Cuota · 58 pagos, del … al …»); for several, a line per lot with its
 *   contract, value and what was paid. Its length never depends on the history.
 * - The annex, «Anexo · Historial de pagos», the line-by-line history on as
 *   many sheets as it takes, `ANNEX_ROWS_PER_PAGE` to a sheet, with a Lote
 *   column when there are several. Every sheet carries the constancia's
 *   number and «Página 2 de 4», so a page that comes loose can be matched to
 *   its letter. It can be left out when the notary does not need the detail.
 *
 * The letterhead, signature and paper are the receipt's (`.receipt-*`), so the
 * two documents read as coming from the same office. A voided one still
 * renders, with ANULADA across every sheet and no «saldo cancelado» seal: it
 * is what the office sees when somebody reads them a code from a constancia
 * that is no longer true.
 */
export function ConstanciaPaper({ constancia, withAnnex }: ConstanciaPaperProps) {
  const { customer, parts } = constancia;
  const isCombined = parts.length > 1;
  const isVoid = constancia.voidedAt !== null;
  const identification = customer.identification?.trim();
  const rows = annexRows(parts);
  const annex = withAnnex ? annexPages(rows) : [];
  const sheetCount = 1 + annex.length;
  const contractCodes = joinSpanish(parts.map((part) => part.contract.code));
  const voidBanner = isVoid && (
    <p className="receipt-void-banner">ANULADA — {constancia.voidReason}</p>
  );
  const valueInWords = (
    <strong>
      {amountInWords(constancia.salePrice)}{" "}
      <span className="constancia-figure">({money(constancia.salePrice)})</span>
    </strong>
  );
  const lastPayment = constancia.lastPaidOn
    ? `, siendo su último pago el ${longDate(constancia.lastPaidOn)}`
    : "";

  return (
    <div className="constancia-sheets">
      <div className={`receipt-paper constancia-paper${isVoid ? " is-void" : ""}`}>
        {voidBanner}
        <Letterhead constancia={constancia} />

        <h1 className="constancia-title">Constancia de Cancelación Total</h1>
        <p className="constancia-subtitle">{lotsPhrase(parts)}</p>

        {isCombined ? (
          <p className="constancia-body">
            Por medio de la presente, <strong>{BUSINESS.name}</strong> hace constar que{" "}
            <strong>{customer.fullName}</strong>
            {identification ? `, con identidad ${identification},` : ""} ha cancelado en su
            totalidad el valor de los <strong>{lotsPhrase(parts).replace(/^Lotes? /, "lotes ")}</strong>,
            que se detallan a continuación, por un total de {valueInWords}, según contratos{" "}
            {contractCodes}
            {lastPayment}. A la fecha, dichos contratos no presentan saldo pendiente.
          </p>
        ) : (
          <p className="constancia-body">
            Por medio de la presente, <strong>{BUSINESS.name}</strong> hace constar que{" "}
            <strong>{customer.fullName}</strong>
            {identification ? `, con identidad ${identification},` : ""} ha cancelado en su
            totalidad el valor de {valueInWords} correspondiente al{" "}
            <strong>{lotsPhrase(parts)}</strong>, según contrato {contractCodes}
            {lastPayment}. A la fecha, dicho contrato no presenta saldo pendiente.
          </p>
        )}

        <div className="constancia-history">
          {isCombined ? (
            <>
              <h4 className="receipt-label">Lotes de esta constancia</h4>
              <table>
                <thead>
                  <tr>
                    <th>Lote</th>
                    <th>Contrato</th>
                    <th>Pagos</th>
                    <th>Período</th>
                    <th className="receipt-right">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {parts.map((part) => (
                    <tr key={part.contract.id}>
                      <td>
                        {part.lot.code}
                        <span className="constancia-cell-note">{part.lot.projectName}</span>
                      </td>
                      <td>{part.contract.code}</td>
                      <td>{payments(part.payments.length)}</td>
                      <td>
                        {part.payments.length > 0
                          ? period(part.payments[0]!.paidOn, part.payments[part.payments.length - 1]!.paidOn)
                          : "—"}
                      </td>
                      <td className="receipt-right">{money(part.contract.salePrice)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4}>
                      Total pagado · {payments(rows.length)} · {parts.length} lotes
                    </td>
                    <td className="receipt-right">{money(constancia.totalPaid)}</td>
                  </tr>
                </tfoot>
              </table>
            </>
          ) : (
            <>
              <h4 className="receipt-label">Resumen de pagos de este contrato</h4>
              <table>
                <thead>
                  <tr>
                    <th>Concepto</th>
                    <th>Pagos</th>
                    <th>Período</th>
                    <th className="receipt-right">Monto</th>
                  </tr>
                </thead>
                <tbody>
                  {summarizePayments(rows).map((line) => (
                    <tr key={line.label}>
                      <td>{line.label}</td>
                      <td>{payments(line.count)}</td>
                      <td>{period(line.firstOn, line.lastOn)}</td>
                      <td className="receipt-right">{money(line.total)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3}>
                      Total pagado · {payments(rows.length)} · Valor del contrato{" "}
                      {money(constancia.salePrice)}
                    </td>
                    <td className="receipt-right">{money(constancia.totalPaid)}</td>
                  </tr>
                </tfoot>
              </table>
            </>
          )}
          {annex.length > 0 && (
            <p className="constancia-annex-note">
              El detalle de cada pago va en el anexo,{" "}
              {annex.length === 1 ? "página 2" : `páginas 2 a ${sheetCount}`}.
            </p>
          )}
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
            {sheetCount > 1 && ` Página 1 de ${sheetCount}.`}
          </p>
        </footer>
      </div>

      {annex.map((sheet, index) => {
        // Numbered across the whole history, so page 3 starts at 65, not at 1.
        const first = index * ANNEX_ROWS_PER_PAGE + 1;

        return (
          <div
            key={index}
            className={`receipt-paper constancia-paper constancia-annex${isVoid ? " is-void" : ""}`}
          >
            {voidBanner}
            {/* A one-line letterhead rather than the letter's: the logo alone
                would take the room of a dozen payments on every sheet. */}
            <header className="constancia-annex-head">
              <div>
                <strong>{BUSINESS.name}</strong>
                <span>Anexo · Historial de pagos</span>
              </div>
              <div className="receipt-right">
                <span>
                  <span className="receipt-label">CONSTANCIA N.º</span> {constancia.code}
                </span>
                <span>
                  <span className="receipt-label">{isCombined ? "CONTRATOS:" : "CONTRATO:"}</span>{" "}
                  {parts.map((part) => part.contract.code).join(", ")}
                </span>
              </div>
            </header>
            <p className="constancia-annex-who">
              {customer.fullName} · {lotsPhrase(parts)}
            </p>

            <div className="constancia-history">
              <table>
                <thead>
                  <tr>
                    <th className="constancia-row-number">N.º</th>
                    {isCombined && <th>Lote</th>}
                    <th>Fecha</th>
                    <th>Concepto</th>
                    <th>Recibo</th>
                    <th className="receipt-right">Monto</th>
                  </tr>
                </thead>
                <tbody>
                  {sheet.map((payment, row) => (
                    <tr key={row}>
                      <td className="constancia-row-number">{first + row}</td>
                      {isCombined && <td>{payment.lotCode}</td>}
                      <td>{shortDate(payment.paidOn)}</td>
                      <td>{paymentTypeLabel(payment.type)}</td>
                      <td>{payment.receiptCode ?? "—"}</td>
                      <td className="receipt-right">{money(payment.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                {index === annex.length - 1 && (
                  <tfoot>
                    <tr>
                      <td colSpan={isCombined ? 5 : 4}>Total pagado · {payments(rows.length)}</td>
                      <td className="receipt-right">{money(constancia.totalPaid)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>

            <footer className="constancia-annex-footer">
              Constancia {constancia.code} · código de verificación {constancia.lookupCode} · Página{" "}
              {index + 2} de {sheetCount}
            </footer>
          </div>
        );
      })}
    </div>
  );
}
