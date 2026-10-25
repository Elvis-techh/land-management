import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import type { Receipt } from "../../types";
import { updateReceiptPaidBy } from "./api";

interface ReceiptPaidByDialogProps {
  receipt: Receipt;
  onClose: () => void;
  onSaved: (receipt: Receipt) => void;
}

const MINIMUM_REASON = 10;

/**
 * Cambiar el «Pagado por» de un recibo ya emitido.
 *
 * For a name typed wrong, or a payer who asks for a receipt in their own name
 * for money already recorded. Only the paper changes: the money stays on the
 * same contracts, under the same customer. It takes a reason and is filed in
 * the Historial, like any change to a document somebody may already hold.
 */
export function ReceiptPaidByDialog({ receipt, onClose, onSaved }: ReceiptPaidByDialogProps) {
  const [paidBy, setPaidBy] = useState(receipt.paidBy ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  const next = paidBy.trim();
  const trimmedReason = reason.trim();
  const changed = next !== (receipt.paidBy ?? "");
  const canSubmit = changed && trimmedReason.length >= MINIMUM_REASON && !isSaving;

  const submit = async () => {
    setError(null);
    setSaving(true);

    try {
      onSaved(await updateReceiptPaidBy(receipt.id, next === "" ? null : next, trimmedReason));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo cambiar el recibo.");
      setSaving(false);
    }
  };

  return (
    <Dialog ariaLabel={`Pagado por, recibo ${receipt.code}`} onClose={onClose}>
      <div className="modal-header">
        <div>
          <p className="modal-eyebrow">Pagado por</p>
          <h2>{receipt.code}</h2>
          <p className="modal-description">Cliente: {receipt.customer.fullName}</p>
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Cerrar">
          <IconClose />
        </button>
      </div>

      <div className="modal-form-grid">
        <p className="form-note full-width">
          El recibo sale a nombre de quien entregó el dinero. El lote, el contrato y el saldo
          siguen siendo de {receipt.customer.fullName}; ninguna cifra cambia.
        </p>

        <div className="form-field full-width">
          <label htmlFor="paid-by-name">Pagado por</label>
          <input
            id="paid-by-name"
            type="text"
            maxLength={120}
            value={paidBy}
            onChange={(event) => setPaidBy(event.target.value)}
            placeholder={receipt.customer.fullName}
          />
          <span className="field-hint">Vacío: el recibo vuelve a salir a nombre del cliente.</span>
        </div>

        <div className="form-field full-width">
          <label htmlFor="paid-by-reason">
            Motivo <span className="required-mark">*</span>
          </label>
          <textarea
            id="paid-by-reason"
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Ej. Él paga el lote y pidió el recibo a su nombre."
          />
          <span className="field-hint">Queda en el Historial.</span>
          {trimmedReason.length > 0 && trimmedReason.length < MINIMUM_REASON && (
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
