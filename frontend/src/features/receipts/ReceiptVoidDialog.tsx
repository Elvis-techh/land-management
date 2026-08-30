import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import type { MoneyView } from "../../lib/money";
import { formatMoney } from "../../lib/money";
import type { Receipt } from "../../types";
import { voidReceipt } from "./api";

interface ReceiptVoidDialogProps {
  receipt: Receipt;
  money: MoneyView;
  onClose: () => void;
  onVoided: () => void;
}

const MINIMUM_REASON = 10;

/**
 * Anular un recibo.
 *
 * Worth being precise about what this does, because "anular" sounds like
 * "delete" and is the opposite of it. The document stays, the number stays, and
 * both remain visible as a void — a missing receipt number cannot be told apart
 * from a hidden one, and a customer holding the printed copy has to be able to
 * be shown why it no longer stands.
 *
 * What changes is that the money stops counting. The payments keep their
 * amount, their date and their rate; every balance in the app already ignores a
 * reversed payment, so the contract, the customer's total and every receipt
 * issued after this one re-derive on their own.
 */
export function ReceiptVoidDialog({ receipt, money, onClose, onVoided }: ReceiptVoidDialogProps) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  const trimmed = reason.trim();
  const canSubmit = trimmed.length >= MINIMUM_REASON && !isSaving;

  const submit = async () => {
    setError(null);
    setSaving(true);

    try {
      await voidReceipt(receipt.id, trimmed);
      onVoided();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo anular el recibo.");
      setSaving(false);
    }
  };

  return (
    <Dialog ariaLabel={`Anular el recibo ${receipt.code}`} onClose={onClose}>
      <div className="modal-header">
        <div>
          <p className="modal-eyebrow danger-eyebrow">Anular recibo</p>
          <h2>{receipt.code}</h2>
          <p className="modal-description">
            {receipt.customer.fullName} · {formatMoney(receipt.totalPaid, money)}
          </p>
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Cerrar">
          <IconClose />
        </button>
      </div>

      <div className="modal-form-grid">
        <p className="form-note full-width">
          El recibo no se borra y su número nunca se reutiliza: queda visible como anulado. Lo que
          cambia es que el dinero deja de contar, así que el saldo del contrato y todos los recibos
          posteriores se recalculan solos.
        </p>

        <div className="form-field full-width">
          <label htmlFor="void-reason">
            Motivo <span className="required-mark">*</span>
          </label>
          <textarea
            id="void-reason"
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Ej. El cheque del cliente fue rechazado por el banco."
          />
          <span className="field-hint">
            Se imprime en el recibo anulado y queda en el historial. Es lo que le explica al cliente
            por qué su copia ya no vale.
          </span>
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
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {isSaving ? "Anulando…" : "Anular recibo"}
        </button>
      </div>
    </Dialog>
  );
}
