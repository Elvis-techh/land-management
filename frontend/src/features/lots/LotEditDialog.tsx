import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import { MoneyInput } from "../../components/MoneyInput";
import { AREA_UNIT_INFO, toAreaInput, toSquareMetres } from "../../lib/area";
import type { AreaUnit } from "../../lib/area";
import { fromCurrencyUnits, parseMoneyInput, toMoneyInput } from "../../lib/money";
import type { Lot } from "../../types";

interface LotEditDialogProps {
  lot: Lot;
  /**
   * Every active lot, so a number that is already taken can be caught here
   * rather than on the round trip. The server checks the same thing and its
   * answer is the one that counts — this only spares the user a failed save.
   */
  lots: Lot[];
  /** The area unit each project is captured in — see lib/area.ts. */
  unitByProject: Map<string, AreaUnit>;
  onCancel: () => void;
  /** Rejects when the server refuses; the message is shown in the dialog. */
  onSave: (changes: {
    code: string;
    projectName: string;
    areaM2: number;
    basePriceCents: number;
    reason?: string;
  }) => Promise<void>;
}

export function LotEditDialog({
  lot,
  lots,
  unitByProject,
  onCancel,
  onSave,
}: LotEditDialogProps) {
  // The lot is shown in its project's unit, and converted back to the stored
  // square metres on save.
  const unit = unitByProject.get(lot.projectName) ?? "m2";
  const unitInfo = AREA_UNIT_INFO[unit];

  const [code, setCode] = useState(lot.code);
  const [projectName, setProjectName] = useState(lot.projectName);
  const [area, setArea] = useState(() => toAreaInput(lot.areaM2, unit));
  // Money is edited in lempiras, with thousand separators, and converted to
  // centavos on save.
  const [basePrice, setBasePrice] = useState(() => toMoneyInput(lot.basePrice));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  // Repricing a lot that is under contract is allowed — prices get
  // renegotiated, especially in the first months — but it is the one lot edit
  // that touches money, so it asks for a written reason and is filed in the
  // history under its own action.
  const priceChanged = fromCurrencyUnits(parseMoneyInput(basePrice) || 0) !== lot.basePrice;
  const needsJustification = lot.holding !== null && priceChanged;

  // Lot numbers are unique WITHIN a project, so moving a lot to another project
  // can collide exactly as renaming it can. Both are measured against whichever
  // project is selected right now, not the one the lot started in.
  const duplicate = lots.some(
    (other) =>
      other.id !== lot.id &&
      other.projectName === projectName.trim() &&
      other.code.toUpperCase() === code.trim().toUpperCase(),
  );

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    const areaValue = Number(area);
    const price = parseMoneyInput(basePrice);

    if (!code.trim()) {
      setError("El número de lote es obligatorio.");
      return;
    }
    if (!projectName.trim()) {
      setError("El proyecto es obligatorio.");
      return;
    }
    if (duplicate) {
      setError(`El lote ${code.trim()} ya existe en ${projectName.trim()}. Usa otro número.`);
      return;
    }
    if (area.trim() === "" || !Number.isFinite(areaValue) || areaValue <= 0) {
      setError("El área debe ser un número mayor que cero.");
      return;
    }
    // An unreadable amount and a negative one are different mistakes, and a
    // blank field told "no puede ser negativo" reads like a bug.
    if (!Number.isFinite(price)) {
      setError("Escribe el precio base en lempiras.");
      return;
    }
    if (price < 0) {
      setError("El precio base no puede ser negativo.");
      return;
    }
    if (needsJustification && reason.trim().length < 10) {
      setError("Explica el motivo del cambio de precio (mínimo 10 caracteres).");
      return;
    }

    setSaving(true);

    try {
      await onSave({
        code: code.trim(),
        projectName: projectName.trim(),
        areaM2: toSquareMetres(areaValue, unit),
        basePriceCents: fromCurrencyUnits(price),
        ...(needsJustification ? { reason: reason.trim() } : {}),
      });
    } catch (caught) {
      // The server enforces the same rules independently, so this is where a
      // permission refusal — or a number held by a lot this screen cannot see,
      // an archived one — surfaces.
      setError(caught instanceof Error ? caught.message : "No se pudo guardar el lote.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog ariaLabel={`Editar lote ${lot.code}`} onClose={onCancel}>
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow">Editar lote</p>
            <h2>{lot.code}</h2>
            <p className="modal-description">
              Los cambios quedan registrados en el historial con tu nombre y la fecha.
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Cerrar">
            <IconClose />
          </button>
        </div>

        <div className="modal-form-grid">
          <div className="form-field">
            <label htmlFor="lot-code">Lote</label>
            <input
              id="lot-code"
              value={code}
              aria-invalid={duplicate}
              onChange={(e) => setCode(e.target.value)}
            />
            {duplicate && (
              <span className="field-error">
                Ya hay un lote {code.trim()} en {projectName.trim()}.
              </span>
            )}
          </div>

          <div className="form-field">
            <label htmlFor="lot-area">Área</label>
            <div className="input-with-suffix">
              <input
                id="lot-area"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={area}
                onChange={(e) => setArea(e.target.value)}
              />
              <span className="unit-suffix">{unitInfo.symbol}</span>
            </div>
            <span className="field-hint">{unitInfo.label}, la unidad de {lot.projectName}.</span>
          </div>

          <div className="form-field full-width">
            <label htmlFor="lot-project">Proyecto</label>
            <input
              id="lot-project"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
            />
          </div>

          <div className="form-field full-width">
            <label htmlFor="lot-price">Precio base</label>
            <MoneyInput id="lot-price" value={basePrice} onChange={setBasePrice} />
            <span className="field-hint">
              Siempre en lempiras. Cambiar el precio base no altera lo que ya deben los
              clientes: cada contrato conserva su propio precio de venta.
            </span>
          </div>

          {needsJustification && (
            <div className="form-field full-width">
              <p className="form-blocked">
                Este lote tiene el contrato <strong>{lot.holding?.contractCode}</strong> vigente.
                El cambio de precio quedará registrado en el Historial con tu nombre, la fecha y
                el motivo.
              </p>
              <label htmlFor="lot-price-reason">
                Motivo del cambio de precio
                <span className="required-mark" aria-hidden="true"> *</span>
              </label>
              <textarea
                id="lot-price-reason"
                rows={3}
                value={reason}
                placeholder="Ej. Precio renegociado con el cliente el 12 de agosto."
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          )}

          {error && <p className="form-error full-width">{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={isSaving}>
            Cancelar
          </button>
          <button
            type="submit"
            className="btn-primary modal-submit"
            disabled={isSaving || duplicate}
          >
            <span>{isSaving ? "Guardando…" : "Guardar cambios"}</span>
          </button>
        </div>
      </form>
    </Dialog>
  );
}
