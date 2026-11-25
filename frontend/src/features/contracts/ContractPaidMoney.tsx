import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import { MoneyInput } from "../../components/MoneyInput";
import { businessToday } from "../../lib/businessTime";
import type { MoneyView } from "../../lib/money";
import { cents, formatMoney, toMoneyInput, typedCents } from "../../lib/money";
import type { User } from "../../lib/permissions";
import { can } from "../../lib/permissions";
import type { Contract, ContractCarryover, ContractRefund } from "../../types";
import { decidePaidMoney, removeCarryover, removeRefund, returnRefund } from "./api";
import { formatDate } from "./contractPresentation";
import { paidMoneySentence } from "./paidMoneyText";

const MINIMUM_REASON = 10;

const METHOD_WORDS: Record<"cash" | "transfer", string> = {
  cash: "efectivo",
  transfer: "transferencia",
};

interface ContractPaidMoneyProps {
  /** A contract an adenda replaced. */
  contract: Contract;
  /** The contract that replaced it, as the list has it, or `null`. */
  successor: Contract | null;
  money: MoneyView;
  user: User;
  /** Re-read everything this moved: both contracts, the transactions, the Panel. */
  onChanged: () => void;
}

/**
 * «Lo pagado con este contrato», on a contract an adenda replaced: what was
 * paid on it, and where each part of that money is now — moved to the new
 * contract, owed back to whoever paid it, given back, or still income.
 *
 * Until somebody decides, all of it stays as income, which is what an adenda
 * has always done. «Decidir lo pagado» moves part or all of it on, or marks it
 * to be given back; each step can be taken back with a reason. The old
 * contract's payments and receipts never change: see src/lib/paidMoney.ts on
 * the server.
 */
export function ContractPaidMoney({ contract, successor, money, user, onChanged }: ContractPaidMoneyProps) {
  const [isDeciding, setDeciding] = useState(false);
  const [returning, setReturning] = useState<ContractRefund | null>(null);
  const [removing, setRemoving] = useState<
    { kind: "carryover"; entry: ContractCarryover } | { kind: "refund"; entry: ContractRefund } | null
  >(null);

  if (contract.status !== "replaced" || contract.paidToDate === 0) {
    return null;
  }

  const canDecide = can(user, "contract:amend");
  const amount = (value: number) => formatMoney(cents(value), money);
  const paidMoney = contract.paidMoney;
  const undecided = paidMoney?.keptCents ?? contract.paidToDate;

  const done = () => {
    setDeciding(false);
    setReturning(null);
    setRemoving(null);
    onChanged();
  };

  return (
    <section className="cp-section">
      <div className="cp-docs-head">
        <h3 className="cp-section-title">Lo pagado con este contrato</h3>
        {canDecide && undecided > 0 && (
          <button type="button" className="btn-secondary is-small" onClick={() => setDeciding(true)}>
            Decidir lo pagado
          </button>
        )}
      </div>

      <div className="cp-row">
        <span>Pagado</span>
        <span className="cell-money">{amount(contract.paidToDate)}</span>
      </div>

      {(paidMoney?.carryovers ?? []).map((entry) => (
        <div key={entry.paymentId} className="cp-row is-wrapping">
          <span className="cp-doc-meta">
            <span>Pasó a {entry.code}</span>
            <span className="cp-doc-sub is-prose">
              {entry.type === "down_payment" ? "Como prima" : "Como cuotas"} · desde el {formatDate(entry.on)}
            </span>
          </span>
          <span className="cp-row-actions">
            <span className="cell-money">{amount(entry.amountCents)}</span>
            {canDecide && (
              <button
                type="button"
                className="link-btn is-danger"
                onClick={() => setRemoving({ kind: "carryover", entry })}
                aria-label={`Quitar el traslado a ${entry.code}`}
              >
                Quitar
              </button>
            )}
          </span>
        </div>
      ))}

      {(paidMoney?.refunds ?? []).map((entry) => (
        <div key={entry.id} className="cp-row is-wrapping">
          <span className="cp-doc-meta">
            <span>
              {entry.returnedOn === null
                ? `Por devolver a ${contract.customer.fullName}`
                : `Devuelto a ${contract.customer.fullName}`}
            </span>
            <span className="cp-doc-sub is-prose">
              {entry.returnedOn === null
                ? // The office's calendar day, not UTC's: after 6 pm UTC is tomorrow.
                  `Decidido el ${formatDate(businessToday(new Date(entry.recordedAt)))}`
                : `El ${formatDate(entry.returnedOn)} · ${METHOD_WORDS[entry.method ?? "cash"]}${
                    entry.reference ? ` · ${entry.reference}` : ""
                  }`}
            </span>
          </span>
          <span className="cp-row-actions">
            <span className={`cell-money${entry.returnedOn === null ? " warn" : ""}`}>
              {amount(entry.amountCents)}
            </span>
            {canDecide && entry.returnedOn === null && (
              <button type="button" className="link-btn" onClick={() => setReturning(entry)}>
                Registrar devolución
              </button>
            )}
            {canDecide && (
              <button
                type="button"
                className="link-btn is-danger"
                onClick={() => setRemoving({ kind: "refund", entry })}
                aria-label={`Quitar la devolución de ${amount(entry.amountCents)}`}
              >
                Quitar
              </button>
            )}
          </span>
        </div>
      ))}

      <div className="cp-row cp-row-total">
        <span>Queda como ingreso</span>
        <span className="cell-money">{amount(undecided)}</span>
      </div>

      <p className="cp-note">
        {paidMoneySentence(paidMoney, contract.paidToDate, money)} Los recibos de este contrato no
        cambian.
      </p>

      {isDeciding && (
        <DecidePaidMoneyDialog
          contract={contract}
          successor={successor}
          undecidedCents={undecided}
          money={money}
          onClose={() => setDeciding(false)}
          onSaved={done}
        />
      )}

      {returning && (
        <ReturnRefundDialog
          contract={contract}
          refund={returning}
          money={money}
          onClose={() => setReturning(null)}
          onSaved={done}
        />
      )}

      {removing && (
        <RemoveDialog
          title={
            removing.kind === "carryover"
              ? `Traslado a ${removing.entry.code} · ${amount(removing.entry.amountCents)}`
              : `Devolución · ${amount(removing.entry.amountCents)}`
          }
          eyebrow={removing.kind === "carryover" ? "Quitar traslado" : "Quitar devolución"}
          contract={contract}
          note={
            removing.kind === "carryover"
              ? `${removing.entry.code} deja de contar ese dinero, y vuelve a quedar por decidir aquí.`
              : "Ese dinero vuelve a quedar por decidir aquí."
          }
          onClose={() => setRemoving(null)}
          onConfirm={(reason) =>
            removing.kind === "carryover"
              ? removeCarryover(removing.entry.paymentId, reason)
              : removeRefund(removing.entry.id, reason)
          }
          onSaved={done}
        />
      )}
    </section>
  );
}

interface DecidePaidMoneyDialogProps {
  contract: Contract;
  successor: Contract | null;
  undecidedCents: number;
  money: MoneyView;
  onClose: () => void;
  onSaved: () => void;
}

/** «Decidir lo pagado»: how much moves on, how much is given back, the rest stays. */
function DecidePaidMoneyDialog({
  contract,
  successor,
  undecidedCents,
  money,
  onClose,
  onSaved,
}: DecidePaidMoneyDialogProps) {
  const today = businessToday();
  const canMove = successor !== null && (successor.status === "active" || successor.status === "paid_off");
  const primaPending =
    successor !== null && successor.downPaymentPaid < successor.terms.downPayment;
  const [carryText, setCarryText] = useState("");
  const [carryType, setCarryType] = useState<"down_payment" | "installment">(
    primaPending ? "down_payment" : "installment",
  );
  const [carryOn, setCarryOn] = useState(successor?.terms.signedOn ?? today);
  const [refundText, setRefundText] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  const amount = (value: number) => formatMoney(cents(value), money);
  const carryCents = canMove ? typedCents(carryText) : 0;
  const refundCents = typedCents(refundText);
  const rest = undecidedCents - carryCents - refundCents;
  const leftAfterRefund = undecidedCents - refundCents;
  const trimmed = reason.trim();
  const owedThere = successor?.balance ?? 0;
  const problem =
    carryCents + refundCents === 0
      ? null
      : rest < 0
        ? `Es más de lo que queda por decidir (${amount(undecidedCents)}).`
        : carryCents > owedThere
          ? `${successor!.code} solo debe ${amount(owedThere)}.`
          : carryCents > 0 && (carryOn === "" || carryOn > today)
            ? "Elige un día que ya pasó."
            : null;
  const canSubmit =
    carryCents + refundCents > 0 && problem === null && trimmed.length >= MINIMUM_REASON && !isSaving;

  const submit = async () => {
    setError(null);
    setSaving(true);

    try {
      await decidePaidMoney(contract.id, {
        carryoverCents: carryCents,
        carryoverType: carryType,
        carryoverOn: carryCents > 0 ? carryOn : null,
        refundCents,
        reason: trimmed,
      });
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo guardar.");
      setSaving(false);
    }
  };

  return (
    <Dialog ariaLabel={`Decidir lo pagado, contrato ${contract.code}`} onClose={onClose}>
      <div className="modal-header">
        <div>
          <p className="modal-eyebrow">Decidir lo pagado</p>
          <h2>{contract.code}</h2>
          <p className="modal-description">
            {contract.customer.fullName} · Lote {contract.lot.code} · Por decidir{" "}
            {amount(undecidedCents)}
          </p>
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Cerrar">
          <IconClose />
        </button>
      </div>

      <div className="modal-form-grid">
        <p className="form-note full-width">
          Lo que pasa al contrato nuevo cuenta para su saldo, pero no es un pago nuevo: no lleva
          recibo ni se suma a lo cobrado del mes. Lo que se devuelve queda «por devolver» hasta que
          registres el día en que se entregó. Lo que no se reparta queda como ingreso. Los recibos de
          este contrato no cambian.
        </p>

        {canMove ? (
          <>
            <div className="form-field">
              <label htmlFor="paid-carry">Pasa a {successor!.code}</label>
              <MoneyInput id="paid-carry" value={carryText} onChange={setCarryText} placeholder="0.00" />
              <span className="field-hint">
                {successor!.customer.fullName} · debe {amount(owedThere)}
                {carryCents === 0 && leftAfterRefund > 0 && leftAfterRefund <= owedThere && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => setCarryText(toMoneyInput(cents(leftAfterRefund)))}
                    >
                      Todo lo que queda
                    </button>
                  </>
                )}
              </span>
            </div>

            <div className="form-field">
              <label htmlFor="paid-carry-type">Cuenta como</label>
              <select
                id="paid-carry-type"
                value={carryType}
                onChange={(event) => setCarryType(event.target.value as "down_payment" | "installment")}
              >
                <option value="down_payment">Prima</option>
                <option value="installment">Cuotas</option>
              </select>
            </div>

            <div className="form-field">
              <label htmlFor="paid-carry-on">Desde</label>
              <input
                id="paid-carry-on"
                type="date"
                value={carryOn}
                min={successor!.terms.signedOn}
                max={today}
                onChange={(event) => setCarryOn(event.target.value)}
              />
              <span className="field-hint">Normalmente el día del acuerdo, {formatDate(successor!.terms.signedOn)}.</span>
            </div>
          </>
        ) : (
          <p className="form-blocked full-width">
            El contrato que reemplazó a este ya no está vigente: no se le puede pasar dinero. Sí se
            puede devolver.
          </p>
        )}

        <div className="form-field">
          <label htmlFor="paid-refund">Se devuelve a {contract.customer.fullName}</label>
          <MoneyInput id="paid-refund" value={refundText} onChange={setRefundText} placeholder="0.00" />
        </div>

        <div className="cp-row cp-row-total full-width">
          <span>Queda como ingreso</span>
          <span className={`cell-money${rest < 0 ? " warn" : ""}`}>{amount(Math.max(0, rest))}</span>
        </div>

        {problem && <p className="field-error full-width">{problem}</p>}

        <div className="form-field full-width">
          <label htmlFor="paid-reason">
            Motivo <span className="required-mark">*</span>
          </label>
          <textarea
            id="paid-reason"
            rows={2}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Ej. La nueva promesa dice que la prima ya está pagada; el resto se le devuelve."
          />
          <span className="field-hint">Queda en el Historial.</span>
          {trimmed.length > 0 && trimmed.length < MINIMUM_REASON && (
            <span className="field-error">Escribe al menos {MINIMUM_REASON} caracteres.</span>
          )}
        </div>

        {error && <p className="form-error full-width">{error}</p>}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cancelar
        </button>
        <button
          type="button"
          className="btn-primary modal-submit"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {isSaving ? "Guardando…" : "Guardar"}
        </button>
      </div>
    </Dialog>
  );
}

interface ReturnRefundDialogProps {
  contract: Contract;
  refund: ContractRefund;
  money: MoneyView;
  onClose: () => void;
  onSaved: () => void;
}

/** «Registrar devolución»: the day the money was handed back, and how. */
function ReturnRefundDialog({ contract, refund, money, onClose, onSaved }: ReturnRefundDialogProps) {
  const today = businessToday();
  const [returnedOn, setReturnedOn] = useState(today);
  const [method, setMethod] = useState<"cash" | "transfer">("cash");
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);
  const canSubmit = returnedOn !== "" && returnedOn <= today && !isSaving;

  const submit = async () => {
    setError(null);
    setSaving(true);

    try {
      await returnRefund(refund.id, {
        returnedOn,
        method,
        reference: method === "transfer" && reference.trim() ? reference.trim() : null,
      });
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo registrar la devolución.");
      setSaving(false);
    }
  };

  return (
    <Dialog ariaLabel={`Registrar devolución, contrato ${contract.code}`} onClose={onClose}>
      <div className="modal-header">
        <div>
          <p className="modal-eyebrow">Registrar devolución</p>
          <h2>{formatMoney(cents(refund.amountCents), money)}</h2>
          <p className="modal-description">
            A {contract.customer.fullName} · {contract.code}
          </p>
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Cerrar">
          <IconClose />
        </button>
      </div>

      <div className="modal-form-grid">
        <p className="form-note full-width">
          Desde ese día cuenta como dinero que salió, en «Devoluciones» del Panel General.
        </p>

        <div className="form-field">
          <label htmlFor="refund-on">
            Fecha <span className="required-mark">*</span>
          </label>
          <input
            id="refund-on"
            type="date"
            value={returnedOn}
            max={today}
            onChange={(event) => setReturnedOn(event.target.value)}
          />
          <span className="field-hint">El día en que se entregó el dinero.</span>
        </div>

        <div className="form-field">
          <label htmlFor="refund-method">Cómo</label>
          <select
            id="refund-method"
            value={method}
            onChange={(event) => setMethod(event.target.value as "cash" | "transfer")}
          >
            <option value="cash">Efectivo</option>
            <option value="transfer">Transferencia</option>
          </select>
        </div>

        {method === "transfer" && (
          <div className="form-field full-width">
            <label htmlFor="refund-reference">Referencia (opcional)</label>
            <input
              id="refund-reference"
              value={reference}
              maxLength={120}
              onChange={(event) => setReference(event.target.value)}
              placeholder="Número de confirmación del banco"
            />
          </div>
        )}

        {error && <p className="form-error full-width">{error}</p>}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cancelar
        </button>
        <button
          type="button"
          className="btn-primary modal-submit"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {isSaving ? "Guardando…" : "Registrar devolución"}
        </button>
      </div>
    </Dialog>
  );
}

interface RemoveDialogProps {
  eyebrow: string;
  title: string;
  note: string;
  contract: Contract;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<unknown>;
  onSaved: () => void;
}

/** «Quitar» a traslado or a devolución entered by mistake. Asks why, and files it. */
function RemoveDialog({ eyebrow, title, note, contract, onClose, onConfirm, onSaved }: RemoveDialogProps) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);
  const trimmed = reason.trim();

  const submit = async () => {
    setError(null);
    setSaving(true);

    try {
      await onConfirm(trimmed);
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo quitar.");
      setSaving(false);
    }
  };

  return (
    <Dialog ariaLabel={`${eyebrow}, contrato ${contract.code}`} onClose={onClose}>
      <div className="modal-header">
        <div>
          <p className="modal-eyebrow danger-eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
          <p className="modal-description">{contract.code}</p>
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Cerrar">
          <IconClose />
        </button>
      </div>

      <div className="modal-form-grid">
        <p className="form-note full-width">{note} Queda en el Historial.</p>

        <div className="form-field full-width">
          <label htmlFor="paid-remove-reason">
            Motivo <span className="required-mark">*</span>
          </label>
          <textarea
            id="paid-remove-reason"
            rows={2}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Ej. Se registró con el monto equivocado."
          />
          {trimmed.length > 0 && trimmed.length < MINIMUM_REASON && (
            <span className="field-error">Escribe al menos {MINIMUM_REASON} caracteres.</span>
          )}
        </div>

        {error && <p className="form-error full-width">{error}</p>}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cancelar
        </button>
        <button
          type="button"
          className="btn-danger modal-submit"
          disabled={trimmed.length < MINIMUM_REASON || isSaving}
          onClick={() => void submit()}
        >
          {isSaving ? "Quitando…" : "Quitar"}
        </button>
      </div>
    </Dialog>
  );
}
