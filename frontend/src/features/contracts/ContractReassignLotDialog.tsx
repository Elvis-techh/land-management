import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import type { AreaUnit } from "../../lib/area";
import type { MoneyView } from "../../lib/money";
import type { Contract, Lot } from "../../types";
import { LotPicker } from "./ContractPartyPickers";

const MINIMUM_REASON_LENGTH = 10;

interface ContractReassignLotDialogProps {
  contract: Contract;
  lots: Lot[];
  unitByProject: Map<string, AreaUnit>;
  money: MoneyView;
  onCancel: () => void;
  /** Rejects when the server refuses; the message is shown in the dialog. */
  onConfirm: (lotId: string, reason: string) => Promise<void>;
}

/**
 * Correcting the lot on a signed contract — for the one case `ContractEditDialog`
 * turns away: a lot mistyped at signing, with payments already recorded
 * against it.
 *
 * Deliberately a dialog of its own rather than an unlocked field on the terms
 * form. "A different lot is a different sale" stays true even for a mistake —
 * this is still a distinct, heavily-audited act. What it spares the office is
 * undoing every payment already posted to the wrong lot: nothing in this app
 * stores a lot id anywhere but on the contract itself, so moving it here is
 * the whole correction — every balance and every past receipt for this
 * contract, old and new, reads the lot it points to now.
 */
export function ContractReassignLotDialog({
  contract,
  lots,
  unitByProject,
  money,
  onCancel,
  onConfirm,
}: ContractReassignLotDialogProps) {
  const [lot, setLot] = useState<Lot | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  const isDirty = lot !== null || reason.trim() !== "";

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!lot) {
      setError("Elige el lote correcto.");
      return;
    }
    if (reason.trim().length < MINIMUM_REASON_LENGTH) {
      setError(`Explica el motivo con al menos ${MINIMUM_REASON_LENGTH} caracteres.`);
      return;
    }

    setSaving(true);

    try {
      await onConfirm(lot.id, reason.trim());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo reasignar el lote.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      ariaLabel={`Reasignar lote de ${contract.code}`}
      dismissible={!isDirty && !isSaving}
      onClose={onCancel}
    >
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow">Corregir el lote</p>
            <h2>{contract.code}</h2>
            <p className="modal-description">
              {contract.customer.fullName} · Actualmente Lote {contract.lot.code} ·{" "}
              {contract.lot.projectName}
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Cerrar">
            <IconClose />
          </button>
        </div>

        <div className="modal-form-grid">
          <p className="form-blocked full-width">
            Esto es para un lote mal capturado, no para vender otro lote — eso es un contrato
            nuevo. Los pagos ya registrados se quedan con este contrato; el lote {contract.lot.code}{" "}
            queda libre en cuanto guardes.
          </p>

          <div className="form-field full-width">
            <label>Lote correcto</label>
            <LotPicker
              lots={lots}
              unitByProject={unitByProject}
              money={money}
              selected={lot}
              onSelect={setLot}
            />
          </div>

          <div className="form-field full-width">
            <label htmlFor="reassign-reason">
              Motivo<span className="required-mark" aria-hidden="true"> *</span>
            </label>
            <textarea
              id="reassign-reason"
              rows={3}
              value={reason}
              placeholder="Ej. Se capturó el lote B-12 por error; el cliente compró el B-21."
              onChange={(event) => setReason(event.target.value)}
            />
            <span className="field-hint">
              Obligatorio: queda en el Historial con tu nombre, la fecha y este motivo.
            </span>
          </div>

          {error && <p className="form-error full-width">{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={isSaving}>
            Cancelar
          </button>
          <button type="submit" className="btn-primary modal-submit" disabled={isSaving || !lot}>
            <span>{isSaving ? "Guardando…" : "Reasignar lote"}</span>
          </button>
        </div>
      </form>
    </Dialog>
  );
}
