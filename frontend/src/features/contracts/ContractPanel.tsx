import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import { getInitials } from "../../lib/initials";
import type { MoneyView } from "../../lib/money";
import { formatMoney } from "../../lib/money";
import { formatPhone } from "../../lib/phone";
import type { User } from "../../lib/permissions";
import { can } from "../../lib/permissions";
import type { Contract } from "../../types";
import {
  HEALTH_PRESENTATION,
  KIND_LABELS,
  SALE_TYPE_LABELS,
  STATUS_PRESENTATION,
  formatDate,
  healthDetail,
  paidPercent,
  primaryStamp,
} from "./contractPresentation";

interface ContractPanelProps {
  contract: Contract;
  /** The other lots of the same purchase, if there are any. */
  siblings: Contract[];
  money: MoneyView;
  user: User;
  onClose: () => void;
  onEditContract: (contract: Contract) => void;
  onCancelContract: (contract: Contract) => void;
}

/**
 * Everything about one contract, in the order somebody asks for it on the
 * phone: who and which lot, what was agreed, what has been paid, where they
 * stand, and what else they bought at the same time.
 */
export function ContractPanel({
  contract,
  siblings,
  money,
  user,
  onClose,
  onEditContract,
  onCancelContract,
}: ContractPanelProps) {
  const stamp = primaryStamp(contract);
  const detail = healthDetail(contract);
  const percent = paidPercent(contract);
  const isActive = contract.status === "active";
  const canEdit = can(user, "contract:edit");
  const canCancel = can(user, "contract:cancel");

  return (
    <Dialog ariaLabel={`Contrato ${contract.code}`} onClose={onClose}>
      <div className="modal-header">
        <div className="cp-identity">
          <div className="cust-avatar cp-avatar">{getInitials(contract.customer.fullName)}</div>
          <div>
            <p className="modal-eyebrow">
              {KIND_LABELS[contract.kind]} · {SALE_TYPE_LABELS[contract.saleType]}
            </p>
            <h2>{contract.code}</h2>
            <p className="modal-description">
              {contract.customer.fullName} · Lote {contract.lot.code} ·{" "}
              {contract.lot.projectName}
            </p>
          </div>
        </div>

        <button type="button" className="modal-close" onClick={onClose} aria-label="Cerrar">
          <IconClose />
        </button>
      </div>

      <div className="cp-body">
        {/* The headline: how far through the price this contract is. Everything
            underneath is the detail behind these two numbers. */}
        <section className="cp-section">
          <div className="contract-progress-head">
            <div>
              <p className="contract-progress-label">Saldo pendiente</p>
              <p className="contract-progress-balance">{formatMoney(contract.balance, money)}</p>
            </div>
            <span className={stamp.stampClass}>{stamp.label}</span>
          </div>

          <div
            className="contract-progress"
            role="img"
            aria-label={`${percent}% pagado`}
            title={`${percent}% pagado`}
          >
            <span className="contract-progress-fill" style={{ width: `${percent}%` }} />
          </div>

          <p className="contract-progress-foot">
            {formatMoney(contract.paidToDate, money)} pagados de{" "}
            {formatMoney(contract.terms.salePrice, money)} · {percent}%
          </p>

          {detail !== "" && <p className="cp-note">{detail}.</p>}
          <p className="cp-note">{HEALTH_PRESENTATION[contract.health.status].hint}</p>
        </section>

        <section className="cp-section">
          <h3 className="cp-section-title">Lo acordado</h3>

          <div className="cp-row">
            <span>Precio de venta</span>
            <span className="cell-money">{formatMoney(contract.terms.salePrice, money)}</span>
          </div>
          <div className="cp-row">
            <span>Prima acordada</span>
            <span className="cell-money">{formatMoney(contract.terms.downPayment, money)}</span>
          </div>
          <div className="cp-row">
            {/* Asked separately on purpose: a prima that was agreed and a prima
                that arrived are different facts, and only one of them is money
                in the account. */}
            <span>Prima cobrada</span>
            <span className="cell-money">
              {formatMoney(contract.downPaymentPaid, money)}
              {contract.downPaymentPaid < contract.terms.downPayment && (
                <span className="cell-sub warn">pendiente</span>
              )}
            </span>
          </div>
          <div className="cp-row">
            <span>Financiado</span>
            <span className="cell-money">{formatMoney(contract.terms.financed, money)}</span>
          </div>

          {contract.terms.monthlyPayment !== null && (
            <>
              <div className="cp-row">
                <span>Plazo</span>
                <span>
                  {contract.terms.termMonths} meses ·{" "}
                  {formatMoney(contract.terms.monthlyPayment, money)} al mes
                </span>
              </div>
              <div className="cp-row">
                <span>Día de pago</span>
                <span>Cada día {contract.terms.dueDay} del mes</span>
              </div>
            </>
          )}

          <div className="cp-row">
            <span>Firma</span>
            <span>{formatDate(contract.terms.signedOn)}</span>
          </div>

          {contract.terms.firstDueOn && (
            <div className="cp-row">
              <span>Primera cuota</span>
              <span>{formatDate(contract.terms.firstDueOn)}</span>
            </div>
          )}

          {contract.kind === "reservation" && (
            <div className="cp-row">
              <span>Vence la reserva</span>
              <span>{formatDate(contract.terms.expiresOn)}</span>
            </div>
          )}
        </section>

        <section className="cp-section">
          <h3 className="cp-section-title">Cómo va</h3>

          <div className="cp-row">
            <span>Pagado hasta hoy</span>
            <span className="cell-money">{formatMoney(contract.paidToDate, money)}</span>
          </div>
          {contract.health.arrears > 0 && (
            <div className="cp-row">
              <span>Vencido sin pagar</span>
              <span className="cell-money warn">
                {formatMoney(contract.health.arrears, money)}
              </span>
            </div>
          )}
          <div className="cp-row">
            <span>Próxima cuota</span>
            <span>
              {contract.health.nextDueOn === null
                ? "No queda nada por pagar"
                : `${formatDate(contract.health.nextDueOn)} · ${formatMoney(
                    contract.health.nextDueAmount,
                    money,
                  )}`}
            </span>
          </div>
          <div className="cp-row cp-row-total">
            <span>Saldo</span>
            <span className="cell-money">{formatMoney(contract.balance, money)}</span>
          </div>

          <p className="cp-note">
            El saldo, el atraso y la próxima cuota se calculan con los pagos registrados cada vez
            que se abre esta pantalla. No son valores editables.
          </p>
        </section>

        {siblings.length > 0 && (
          <section className="cp-section">
            <h3 className="cp-section-title">Los otros lotes de esta compra</h3>
            {/* One signature, one payment, one receipt — but a balance each,
                because the lots are released and titled one at a time. */}
            {siblings.map((sibling) => (
              <div key={sibling.id} className="cp-row">
                <span>
                  {sibling.lot.code} · {sibling.code}
                </span>
                <span className="cell-money">{formatMoney(sibling.balance, money)}</span>
              </div>
            ))}
            <p className="cp-note">
              Un solo recibo cubre los {siblings.length + 1} lotes; el monto se reparte entre ellos
              y cada uno guarda su propio saldo.
            </p>
          </section>
        )}

        <section className="cp-section">
          <h3 className="cp-section-title">Cliente</h3>
          <div className="cp-row">
            <span>Nombre</span>
            <span>{contract.customer.fullName}</span>
          </div>
          <div className="cp-row">
            <span>Teléfono</span>
            {/* Stored with its country code; read back the local way. */}
            <span className="mono">{formatPhone(contract.customer.phone)}</span>
          </div>
          <div className="cp-row">
            <span>Situación</span>
            <span className={STATUS_PRESENTATION[contract.status].stampClass}>
              {STATUS_PRESENTATION[contract.status].label}
            </span>
          </div>
          {contract.closedAt && (
            <div className="cp-row">
              <span>Motivo del cierre</span>
              <span>{contract.closedReason ?? "—"}</span>
            </div>
          )}
        </section>

        {contract.notes && (
          <section className="cp-section">
            <h3 className="cp-section-title">Notas</h3>
            <p className="cp-note-body">{contract.notes}</p>
          </section>
        )}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cerrar
        </button>
        {/* Shown only while there is something to act on. The server re-checks
            both capabilities either way — hiding a button is convenience, not
            security. Editing sits before cancelling because it is the far more
            common of the two, and because the destructive one should not be
            the button the hand goes to by default. */}
        {isActive && canEdit && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => onEditContract(contract)}
          >
            <span>Editar términos</span>
          </button>
        )}
        {isActive && canCancel && (
          <button
            type="button"
            className="btn-danger"
            onClick={() => onCancelContract(contract)}
          >
            <span>Cancelar contrato</span>
          </button>
        )}
      </div>
    </Dialog>
  );
}
