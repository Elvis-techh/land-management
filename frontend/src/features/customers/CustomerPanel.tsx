import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import { getInitials } from "../../lib/initials";
import type { MoneyView } from "../../lib/money";
import { formatMoney, subtractMoney } from "../../lib/money";
import type { Customer, Lot } from "../../types";

interface CustomerPanelProps {
  customer: Customer;
  /** The lot the user clicked from, giving the panel its contract context. */
  lot: Lot;
  money: MoneyView;
  onClose: () => void;
  /** Jump to the full Clientes screen. */
  onViewFullRecord: () => void;
}

export function CustomerPanel({
  customer,
  lot,
  money,
  onClose,
  onViewFullRecord,
}: CustomerPanelProps) {
  const holding = lot.holding;
  const balance = holding ? subtractMoney(holding.salePrice, holding.paidToDate) : null;

  return (
    <Dialog ariaLabel={customer.fullName} onClose={onClose}>
        <div className="modal-header">
          <div className="cp-identity">
            <div className="cust-avatar cp-avatar">{getInitials(customer.fullName)}</div>
            <div>
              <p className="modal-eyebrow">Cliente</p>
              <h2>{customer.fullName}</h2>
              <p className="modal-description">
                Cliente desde {customer.customerSince} · Lote {lot.code}
              </p>
            </div>
          </div>

          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Cerrar"
          >
            <IconClose />
          </button>
        </div>

        <div className="cp-body">
          <section className="cp-section">
            <h3 className="cp-section-title">Contacto</h3>
            <div className="cp-row">
              <span>Identidad</span>
              <span className="mono">{customer.identification}</span>
            </div>
            <div className="cp-row">
              <span>Teléfono</span>
              <span className="mono">{customer.phone}</span>
            </div>
            <div className="cp-row">
              <span>Correo</span>
              <span>{customer.email ?? "—"}</span>
            </div>
            <div className="cp-row">
              <span>Dirección</span>
              <span>{customer.address ?? "—"}</span>
            </div>
          </section>

          {holding && balance !== null && (
            <section className="cp-section">
              <h3 className="cp-section-title">
                {holding.kind === "reservation" ? "Reserva" : "Contrato"}
              </h3>
              <div className="cp-row">
                <span>Número</span>
                <span className="mono">{holding.contractCode}</span>
              </div>
              <div className="cp-row">
                <span>Lote</span>
                <span>
                  <span className="code-badge">{lot.code}</span>
                </span>
              </div>
              <div className="cp-row">
                <span>Proyecto</span>
                <span>{lot.projectName}</span>
              </div>
              <div className="cp-row">
                <span>Precio de venta</span>
                <span className="cell-money">{formatMoney(holding.salePrice, money)}</span>
              </div>
              <div className="cp-row">
                <span>Pagado</span>
                <span className="cell-money">{formatMoney(holding.paidToDate, money)}</span>
              </div>
              <div className="cp-row cp-row-total">
                <span>Saldo</span>
                <span className="cell-money">{formatMoney(balance, money)}</span>
              </div>
              <p className="cp-note">
                El saldo se calcula a partir de los pagos registrados. No es un valor editable.
              </p>
            </section>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cerrar
          </button>
          <button type="button" className="btn-primary" onClick={onViewFullRecord}>
            <span>Ver ficha completa</span>
          </button>
        </div>
    </Dialog>
  );
}