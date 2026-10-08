import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import { businessToday } from "../../lib/businessTime";
import { getInitials } from "../../lib/initials";
import type { MoneyView } from "../../lib/money";
import { formatMoney } from "../../lib/money";
import { formatPhone } from "../../lib/phone";
import type { User } from "../../lib/permissions";
import { can } from "../../lib/permissions";
import type { Contract, ContractAmendmentLink } from "../../types";
import { ContractDocuments } from "./ContractDocuments";
import {
  HEALTH_PRESENTATION,
  KIND_LABELS,
  SALE_TYPE_LABELS,
  SETTLEMENT_LABELS,
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
  /**
   * The contracts on either side of an adenda, as the list has them: the one
   * this contract replaced, and the one that replaced it. `null` when there is
   * no adenda on that side — or, briefly, when the list has not caught up.
   */
  predecessor: Contract | null;
  successor: Contract | null;
  money: MoneyView;
  user: User;
  onClose: () => void;
  onEditContract: (contract: Contract) => void;
  onReassignLot: (contract: Contract) => void;
  onCancelContract: (contract: Contract) => void;
  onDefaultContract: (contract: Contract) => void;
  /** Opens the adenda dialog for this contract's purchase. */
  onAmendContract: (contract: Contract) => void;
  /** Swaps the panel over to another contract — the other side of an adenda. */
  onOpenContract: (contract: Contract) => void;
  /**
   * Re-read the contracts list after paperwork is filed or removed.
   *
   * The list marks which contracts have their signed copy on file, and that
   * marker comes from the list's own `documentCount` — so filing one here has
   * to reach back up.
   */
  onDocumentsChanged: () => void;
}

/**
 * Everything about one contract, in the order somebody asks for it on the
 * phone: who and which lot, what was agreed, what has been paid, where they
 * stand, and what else they bought at the same time.
 */
/** "L 450,000 · prima L 30,000 · 60 × L 7,000", the terms as they are said. */
function termsSummary(contract: Contract, money: MoneyView): string {
  const price = formatMoney(contract.terms.salePrice, money);

  if (contract.terms.monthlyPayment === null || contract.terms.termMonths === null) {
    return `${price} · ${SALE_TYPE_LABELS[contract.saleType].toLowerCase()}`;
  }

  return (
    `${price} · prima ${formatMoney(contract.terms.downPayment, money)} · ` +
    `${contract.terms.termMonths} × ${formatMoney(contract.terms.monthlyPayment, money)}`
  );
}

/** The office's calendar day an instant fell on, e.g. "28 sep 2026". */
function formatRecordedOn(timestamp: string): string {
  const instant = new Date(timestamp.includes("T") ? timestamp : `${timestamp.replace(" ", "T")}Z`);

  return Number.isNaN(instant.getTime()) ? timestamp : formatDate(businessToday(instant));
}

/**
 * One side of an adenda: the contract across it, what it said, and the
 * agreement that drew the line — who approved it, why, and when.
 *
 * Written so the question "what did he have before, and what does he have
 * now?" is answered on this screen, not by reading the Historial.
 */
function AmendmentSide({
  heading,
  link,
  other,
  money,
  paidNote,
  onOpen,
}: {
  heading: string;
  link: ContractAmendmentLink;
  other: Contract | null;
  money: MoneyView;
  /** What to say about the money paid under the OLD contract, if this side has one. */
  paidNote: string | null;
  onOpen: (contract: Contract) => void;
}) {
  return (
    <>
      <div className="cp-row">
        <span>{heading}</span>
        {other ? (
          <button
            type="button"
            className="link-btn"
            onClick={() => onOpen(other)}
            title={`Ver el contrato ${link.code}`}
          >
            {link.code}
          </button>
        ) : (
          <span className="mono">{link.code}</span>
        )}
      </div>
      {other && (
        <div className="cp-row">
          <span>{other.status === "replaced" ? "Decía" : "Dice"}</span>
          <span>{termsSummary(other, money)}</span>
        </div>
      )}
      {paidNote && (
        <div className="cp-row">
          <span>Pagado con ese contrato</span>
          <span>{paidNote}</span>
        </div>
      )}
      <div className="cp-row">
        <span>Fecha del acuerdo</span>
        <span>{formatDate(link.amendment.effectiveOn)}</span>
      </div>
      <div className="cp-row">
        <span>Autorizó</span>
        <span>{link.amendment.authorizedBy ?? "—"}</span>
      </div>
      <div className="cp-row">
        <span>Registró</span>
        <span>
          {link.amendment.recordedBy} · {formatRecordedOn(link.amendment.recordedAt)}
        </span>
      </div>
      <p className="cp-note-body">{link.amendment.reason}</p>
    </>
  );
}

export function ContractPanel({
  contract,
  siblings,
  predecessor,
  successor,
  money,
  user,
  onClose,
  onEditContract,
  onReassignLot,
  onCancelContract,
  onDefaultContract,
  onAmendContract,
  onOpenContract,
  onDocumentsChanged,
}: ContractPanelProps) {
  const stamp = primaryStamp(contract);
  const detail = healthDetail(contract);
  const percent = paidPercent(contract);
  // Prima and financiado are terms of a CREDIT sale. A venta de contado is
  // settled in full at signing and a donación is settled at zero, so on those
  // two the three rows are structurally empty — see "Lo acordado" below.
  const isFinanced = contract.saleType === "financed";
  // Both `active` and `paid_off` contracts can still be closed — the lot is
  // spoken for either way.
  const isOpen = contract.status === "active" || contract.status === "paid_off";
  const canEdit = can(user, "contract:edit");
  const canReassignLot = can(user, "contract:reassign_lot");
  const canCancel = can(user, "contract:cancel");
  const canDefault = can(user, "contract:default");
  // A reservation is converted with «Editar términos», not amended.
  const canAmend =
    contract.status === "active" && contract.kind === "contract" && can(user, "contract:amend");

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
              {/* A closed contract no longer owes anything to anybody: what is
                  left is where it stood when it closed, and it must not read
                  as a debt still being chased. */}
              <p className="contract-progress-label">
                {isOpen ? "Saldo pendiente" : "Saldo al cerrarse"}
              </p>
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

          {isOpen && detail !== "" && <p className="cp-note">{detail}.</p>}
          {isOpen && <p className="cp-note">{HEALTH_PRESENTATION[contract.health.status].hint}</p>}
          {contract.status === "replaced" && contract.replacedBy && (
            <p className="cp-note">
              Ya no se cobra: lo reemplazó {contract.replacedBy.code} el{" "}
              {formatDate(contract.replacedBy.amendment.effectiveOn)}. Lo pagado quedó como ingreso.
            </p>
          )}
        </section>

        <section className="cp-section">
          <h3 className="cp-section-title">Lo acordado</h3>

          <div className="cp-row">
            <span>Precio de venta</span>
            <span className="cell-money">{formatMoney(contract.terms.salePrice, money)}</span>
          </div>
          {/* Only on a credit sale. On a contado these three would read a
              prima of zero, a prima cobrada of zero, and a "financiado" equal
              to the whole price — three lines saying nothing, and the last one
              saying something untrue about a sale that finances nothing. What
              a contado owes is the balance at the top of the panel. */}
          {isFinanced && (
            <>
              <div className="cp-row">
                <span>Prima acordada</span>
                <span className="cell-money">
                  {formatMoney(contract.terms.downPayment, money)}
                </span>
              </div>
              <div className="cp-row">
                {/* Asked separately on purpose: a prima that was agreed and a
                    prima that arrived are different facts, and only one of them
                    is money in the account. */}
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
            </>
          )}

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
          {isOpen && contract.health.arrears > 0 && (
            <div className="cp-row">
              <span>Vencido sin pagar</span>
              <span className="cell-money warn">
                {formatMoney(contract.health.arrears, money)}
              </span>
            </div>
          )}
          {/* Only while the contract is open. A closed one has no next cuota,
              whatever its schedule would still say. */}
          {isOpen && (
            <div className="cp-row">
              <span>Próxima cuota</span>
              <span>
                {contract.health.nextDueOn === null
                  ? "No queda nada por pagar"
                  : `${formatDate(contract.health.nextDueOn)} · ${formatMoney(
                      contract.health.nextInstallment,
                      money,
                    )}${
                      contract.health.nextDueCredit > 0
                        ? ` (adelanto ${formatMoney(contract.health.nextDueCredit, money)})`
                        : ""
                    }`}
              </span>
            </div>
          )}
          <div className="cp-row cp-row-total">
            <span>Saldo</span>
            <span className="cell-money">{formatMoney(contract.balance, money)}</span>
          </div>

          <p className="cp-note">
            El saldo, el atraso y la próxima cuota se calculan con los pagos registrados cada vez
            que se abre esta pantalla. No son valores editables.
          </p>
        </section>

        {/* Both sides at once on a contract amended twice: what it replaced,
            and what later replaced it. */}
        {(contract.replaces || contract.replacedBy) && (
          <section className="cp-section">
            <h3 className="cp-section-title">Adenda</h3>
            {contract.replaces && (
              <AmendmentSide
                heading="Reemplaza a"
                link={contract.replaces}
                other={predecessor}
                money={money}
                paidNote={
                  predecessor
                    ? `${formatMoney(predecessor.paidToDate, money)} · quedó como ingreso, no se abona a este precio`
                    : null
                }
                onOpen={onOpenContract}
              />
            )}
            {contract.replaces && contract.replacedBy && <hr className="cp-divider" />}
            {contract.replacedBy && (
              <AmendmentSide
                heading="Reemplazado por"
                link={contract.replacedBy}
                other={successor}
                money={money}
                paidNote={null}
                onOpen={onOpenContract}
              />
            )}
          </section>
        )}

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
            {/* Stored with its country code; read back the local way. `null`
                when it was never given — a paid-off lot may never have needed
                one. */}
            <span className="mono">
              {contract.customer.phone ? formatPhone(contract.customer.phone) : "—"}
            </span>
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
          {contract.closedSettlement && (
            <div className="cp-row">
              <span>Lo ya pagado</span>
              <span>{SETTLEMENT_LABELS[contract.closedSettlement]}</span>
            </div>
          )}
        </section>

        {/*
          The actual legal document, beside everything derived from it.

          Last in the panel on purpose: the figures above are what somebody
          reads on the phone every day, and the signed scan is what they go
          looking for on the rare day it matters. Being at the foot is not
          being buried — it is the one section whose absence is itself
          information, so it renders whether or not anything has been filed.
        */}
        <ContractDocuments
          contractId={contract.id}
          user={user}
          onCountChanged={onDocumentsChanged}
        />

        {contract.notes && (
          <section className="cp-section">
            <h3 className="cp-section-title">Notas</h3>
            <p className="cp-note-body">{contract.notes}</p>
          </section>
        )}
      </div>

      <div className="modal-actions cp-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cerrar
        </button>
        {/* Shown only while there is something to act on. The server re-checks
            every capability either way — hiding a button is convenience, not
            security. Editing sits first because it is by far the most common;
            the destructive actions should not be where the hand goes by
            default. "Editar términos" needs an active contract; closing one
            works on a paid-off contract too. */}
        {contract.status === "active" && canEdit && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => onEditContract(contract)}
          >
            <span>Editar términos</span>
          </button>
        )}
        {canAmend && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => onAmendContract(contract)}
            title="Nuevo precio o plazo acordado: cierra este contrato y abre uno nuevo, sin tocar sus pagos ni sus recibos."
          >
            <span>Adenda</span>
          </button>
        )}
        {isOpen && canReassignLot && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => onReassignLot(contract)}
            title="Solo para un lote mal capturado por error, no para vender otro lote."
          >
            <span>Corregir lote</span>
          </button>
        )}
        {isOpen && canDefault && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => onDefaultContract(contract)}
            title="El cliente ya no puede pagar: se libera el lote y se registra el incumplimiento."
          >
            <span>Marcar como incumplido</span>
          </button>
        )}
        {isOpen && canCancel && (
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
