import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import { businessToday } from "../../lib/businessTime";
import type { MoneyView } from "../../lib/money";
import { formatMoney } from "../../lib/money";
import type { Contract, CustomerRecord } from "../../types";
import type { TransferDraft } from "./api";
import { CustomerPicker } from "./ContractPartyPickers";

const MINIMUM_REASON_LENGTH = 10;

interface ContractTransferDialogProps {
  contract: Contract;
  /** The other open lots of the same purchase, which normally go with it. */
  siblings: Contract[];
  customers: CustomerRecord[];
  money: MoneyView;
  onCancel: () => void;
  /** Rejects when the server refuses; the message is shown in the dialog. */
  onConfirm: (draft: TransferDraft) => Promise<void>;
}

/**
 * «Traspasar»: the contract passes to another person, who signed a new
 * promesa de venta for it.
 *
 * Not «Editar términos», which never changes the customer, and not a new sale:
 * everything the lot carries goes with it — what was paid, the balance, the
 * cuotas and the contract number. The receipts already issued keep the name
 * they were made out to; the next one is in the new holder's name.
 *
 * The new holder is picked from Clientes, the same as on «Nuevo contrato»:
 * somebody who holds a contract has to be on file first.
 */
export function ContractTransferDialog({
  contract,
  siblings,
  customers,
  money,
  onCancel,
  onConfirm,
}: ContractTransferDialogProps) {
  const [initialToday] = useState(() => businessToday());
  const [recipient, setRecipient] = useState<CustomerRecord | null>(null);
  const [effectiveOn, setEffectiveOn] = useState(initialToday);
  const [reason, setReason] = useState("");
  // The rest of the purchase goes with it unless somebody says otherwise:
  // lots bought together are normally handed over together.
  const [withSiblings, setWithSiblings] = useState<ReadonlySet<string>>(
    () => new Set(siblings.map((sibling) => sibling.id)),
  );
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  const isDirty = recipient !== null || reason.trim() !== "" || effectiveOn !== initialToday;
  const holder = contract.customer.fullName;
  // Somebody cannot be handed what they already hold.
  const candidates = customers.filter((customer) => customer.id !== contract.customer.id);
  const moving = [contract, ...siblings.filter((sibling) => withSiblings.has(sibling.id))];

  const toggleSibling = (id: string) => {
    setWithSiblings((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!recipient) {
      setError("Elige al nuevo titular.");
      return;
    }
    if (effectiveOn === "") {
      setError("Indica la fecha del traspaso.");
      return;
    }
    if (reason.trim().length < MINIMUM_REASON_LENGTH) {
      setError(`Explica el motivo con al menos ${MINIMUM_REASON_LENGTH} caracteres.`);
      return;
    }

    setSaving(true);

    try {
      await onConfirm({
        contractIds: moving.map((entry) => entry.id),
        toCustomerId: recipient.id,
        effectiveOn,
        reason: reason.trim(),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo traspasar el contrato.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      ariaLabel={`Traspasar ${contract.code}`}
      dismissible={!isDirty && !isSaving}
      onClose={onCancel}
    >
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow">Traspasar contrato</p>
            <h2>{contract.code}</h2>
            <p className="modal-description">
              {holder} · Lote {contract.lot.code} · {contract.lot.projectName}
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Cerrar">
            <IconClose />
          </button>
        </div>

        <div className="modal-form-grid">
          <p className="form-blocked full-width">
            Para cuando el contrato pasa a otra persona, con una nueva promesa de venta. Lo pagado (
            {formatMoney(contract.paidToDate, money)}), el saldo (
            {formatMoney(contract.balance, money)}) y las cuotas pasan con el lote al nuevo
            titular. Los recibos ya emitidos se quedan a nombre de {holder}; los siguientes salen a
            nombre del nuevo titular. Si además cambia el precio o el plazo, haz después una adenda.
          </p>

          {siblings.length > 0 && (
            <fieldset className="form-field full-width settlement-choice">
              <legend>Los otros lotes de esta compra</legend>
              {siblings.map((sibling) => (
                <label key={sibling.id} className="settlement-option">
                  <input
                    type="checkbox"
                    checked={withSiblings.has(sibling.id)}
                    onChange={() => toggleSibling(sibling.id)}
                  />
                  <span>
                    Traspasar también el lote {sibling.lot.code} · {sibling.code} (saldo{" "}
                    {formatMoney(sibling.balance, money)})
                  </span>
                </label>
              ))}
              <span className="field-hint">
                Se compraron juntos y se pagan con un solo recibo. El que no pase se queda con{" "}
                {holder}, y lo que pase queda como compra aparte.
              </span>
            </fieldset>
          )}

          <div className="form-field full-width">
            <label>
              Nuevo titular<span className="required-mark" aria-hidden="true"> *</span>
            </label>
            <CustomerPicker
              customers={candidates}
              selected={recipient}
              onSelect={setRecipient}
              inputId="transfer-recipient"
            />
            <span className="field-hint">
              ¿No aparece? Regístralo primero en Clientes y vuelve a abrir el traspaso.
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="transfer-date">
              Fecha del traspaso<span className="required-mark" aria-hidden="true"> *</span>
            </label>
            <input
              id="transfer-date"
              type="date"
              value={effectiveOn}
              min={contract.terms.signedOn}
              max={initialToday}
              onChange={(event) => setEffectiveOn(event.target.value)}
            />
            <span className="field-hint">El día en que se firmó la nueva promesa de venta.</span>
          </div>

          <div className="form-field full-width">
            <label htmlFor="transfer-reason">
              Motivo<span className="required-mark" aria-hidden="true"> *</span>
            </label>
            <textarea
              id="transfer-reason"
              rows={3}
              value={reason}
              placeholder="Ej. La familia acordó que el lote pasa al hijo; firmó nueva promesa de venta."
              onChange={(event) => setReason(event.target.value)}
            />
            <span className="field-hint">
              Obligatorio: queda en el Historial y en el contrato, con tu nombre y la fecha. Sube
              la promesa de venta firmada en «Documentos» del contrato.
            </span>
          </div>

          {error && <p className="form-error full-width">{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={isSaving}>
            Cancelar
          </button>
          <button
            type="submit"
            className="btn-primary modal-submit"
            disabled={isSaving || recipient === null}
          >
            <span>
              {isSaving
                ? "Guardando…"
                : recipient
                  ? `Traspasar a ${recipient.fullName}`
                  : "Traspasar"}
            </span>
          </button>
        </div>
      </form>
    </Dialog>
  );
}
