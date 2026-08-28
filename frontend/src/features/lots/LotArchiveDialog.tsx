import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import type { Lot } from "../../types";

const MINIMUM_REASON_LENGTH = 10;

interface LotArchiveDialogProps {
  lot: Lot;
  onCancel: () => void;
  /** Rejects when the server refuses; the message is shown in the dialog. */
  onConfirm: (reason: string) => Promise<void>;
}

/**
 * Archiving, not deleting.
 *
 * A lot that has ever carried a contract cannot be removed without tearing a
 * hole in the financial history, so Lindero hides it instead of destroying it.
 * The reason is required because this is one of the few actions somebody may
 * genuinely need explained back to them months later.
 */
export function LotArchiveDialog({ lot, onCancel, onConfirm }: LotArchiveDialogProps) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isArchiving, setArchiving] = useState(false);

  const isBlocked = lot.holding !== null;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (reason.trim().length < MINIMUM_REASON_LENGTH) {
      setError(`Explica el motivo con al menos ${MINIMUM_REASON_LENGTH} caracteres.`);
      return;
    }

    setArchiving(true);

    try {
      await onConfirm(reason.trim());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo archivar el lote.");
    } finally {
      setArchiving(false);
    }
  };

  return (
    <Dialog ariaLabel={`Archivar lote ${lot.code}`} onClose={onCancel}>
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow danger-eyebrow">Archivar lote</p>
            <h2>{lot.code}</h2>
            <p className="modal-description">
              El lote deja de aparecer en el inventario activo, pero su historial se conserva.
              Nada se elimina.
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Cerrar">
            <IconClose />
          </button>
        </div>

        <div className="modal-form-grid">
          {isBlocked ? (
            <p className="form-blocked full-width">
              Este lote no se puede archivar porque tiene un contrato o reserva vigente
              ({lot.holding?.contractCode}). Primero hay que cancelar el contrato.
            </p>
          ) : (
            <div className="form-field full-width">
              <label htmlFor="archive-reason">
                Motivo<span className="required-mark" aria-hidden="true"> *</span>
              </label>
              <textarea
                id="archive-reason"
                rows={3}
                value={reason}
                placeholder="Ej. Lote duplicado por error de captura el 12 de agosto."
                onChange={(event) => setReason(event.target.value)}
              />
              <span className="field-hint">
                Queda guardado en el historial junto con tu nombre y la fecha.
              </span>
            </div>
          )}

          {error && <p className="form-error full-width">{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={isArchiving}>
            Cancelar
          </button>
          <button type="submit" className="btn-danger" disabled={isBlocked || isArchiving}>
            {isArchiving ? "Archivando…" : "Archivar lote"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
