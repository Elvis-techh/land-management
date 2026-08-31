import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import type { MoneyView } from "../../lib/money";
import { formatMoney } from "../../lib/money";
import type { Contract } from "../../types";

const MINIMUM_REASON_LENGTH = 10;

interface ContractCancelDialogProps {
  contract: Contract;
  money: MoneyView;
  onCancel: () => void;
  /** Rejects when the server refuses; the message is shown in the dialog. */
  onConfirm: (reason: string) => Promise<void>;
}

/**
 * Cancelling a contract, which gives the lot back.
 *
 * Nothing is deleted: the contract stays, its payments stay, and the lot
 * becomes available again on its own because availability is derived from
 * active contracts rather than written anywhere.
 *
 * The dialog says out loud what has already been paid, because that is the part
 * that turns into a real conversation about a refund the moment somebody
 * confirms — and it is exactly what is easiest to forget when a lot is being
 * released in a hurry.
 */
export function ContractCancelDialog({
  contract,
  money,
  onCancel,
  onConfirm,
}: ContractCancelDialogProps) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isCancelling, setCancelling] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (reason.trim().length < MINIMUM_REASON_LENGTH) {
      setError(`Explica el motivo con al menos ${MINIMUM_REASON_LENGTH} caracteres.`);
      return;
    }

    setCancelling(true);

    try {
      await onConfirm(reason.trim());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo cancelar el contrato.");
    } finally {
      setCancelling(false);
    }
  };

  return (
    <Dialog ariaLabel={`Cancelar contrato ${contract.code}`} onClose={onCancel}>
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow danger-eyebrow">Cancelar contrato</p>
            <h2>{contract.code}</h2>
            <p className="modal-description">
              El lote {contract.lot.code} vuelve a quedar disponible. El contrato y sus pagos se
              conservan en el historial: nada se elimina.
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Cerrar">
            <IconClose />
          </button>
        </div>

        <div className="modal-form-grid">
          {contract.paidToDate > 0 && (
            <p className="form-blocked full-width">
              {contract.customer.fullName} ya pagó {formatMoney(contract.paidToDate, money)} en
              este contrato. Cancelarlo no devuelve ese dinero ni lo mueve a otro lote; queda
              registrado aquí hasta que se decida qué hacer con él.
            </p>
          )}

          <div className="form-field full-width">
            <label htmlFor="cancel-reason">
              Motivo<span className="required-mark" aria-hidden="true"> *</span>
            </label>
            <textarea
              id="cancel-reason"
              rows={3}
              value={reason}
              placeholder="Ej. El cliente desistió de la compra y se acordó devolver la prima."
              onChange={(event) => setReason(event.target.value)}
            />
            <span className="field-hint">
              Queda guardado en el historial junto con tu nombre y la fecha.
            </span>
          </div>

          {error && <p className="form-error full-width">{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={isCancelling}>
            Volver
          </button>
          <button type="submit" className="btn-danger" disabled={isCancelling}>
            {isCancelling ? "Cancelando…" : "Cancelar contrato"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
