import type { FormEvent } from "react";
import { useMemo, useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import { MoneyInput } from "../../components/MoneyInput";
import { AREA_UNIT_INFO, toSquareMetres } from "../../lib/area";
import type { AreaUnit } from "../../lib/area";
import { fromCurrencyUnits, parseMoneyInput } from "../../lib/money";
import type { Lot } from "../../types";
import { formatLotCode, prefixesInUse, suggestNextNumber, suggestPrefix } from "./lotCode";

interface LotCreateDialogProps {
  /** Every active lot, used to work out what the next code should be. */
  lots: Lot[];
  /** Project names, in the order the server sent them. */
  projectNames: string[];
  /** The area unit each project is captured in — see lib/area.ts. */
  unitByProject: Map<string, AreaUnit>;
  onCancel: () => void;
  /** Rejects when the server refuses; the message is shown in the dialog. */
  onCreate: (lot: {
    code: string;
    projectName: string;
    areaM2: number;
    basePriceCents: number;
  }) => Promise<void>;
}

/**
 * The "Nuevo lote" form.
 *
 * Cliente and Estado are absent on purpose. Both are derived from contracts —
 * a lot with no contract IS available — so offering them here would let someone
 * create a lot that claims to be sold with nobody owning it.
 */
export function LotCreateDialog({
  lots,
  projectNames,
  unitByProject,
  onCancel,
  onCreate,
}: LotCreateDialogProps) {
  const [projectName, setProjectName] = useState(projectNames[0] ?? "");

  // The codes in the selected project. Codes are unique per project, so a
  // suggestion built from another project's numbering would be meaningless.
  const codesInProject = useMemo(
    () => lots.filter((lot) => lot.projectName === projectName).map((lot) => lot.code),
    [lots, projectName],
  );

  const knownPrefixes = useMemo(() => prefixesInUse(codesInProject), [codesInProject]);

  // `null` means "follow the suggestion". Once the user types, their value is
  // kept verbatim — the suggestion never overwrites a decision they made.
  const [prefixOverride, setPrefixOverride] = useState<string | null>(null);
  const [numberOverride, setNumberOverride] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState<string | null>(null);

  // The area as TYPED, in the project's unit. It becomes square metres on save.
  const [area, setArea] = useState("");
  // Money is typed in lempiras with thousand separators, and becomes centavos
  // on save.
  const [basePrice, setBasePrice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  // The unit follows the project. A project is sold in one unit, so there is
  // nothing to choose here — picking the project has already decided it.
  const unit = unitByProject.get(projectName) ?? "m2";
  const unitInfo = AREA_UNIT_INFO[unit];
  const areaValue = Number(area);
  const areaIsUsable = area.trim() !== "" && Number.isFinite(areaValue) && areaValue > 0;

  const prefix = prefixOverride ?? suggestPrefix(codesInProject);
  const number = numberOverride ?? suggestNextNumber(codesInProject, prefix);
  const isManual = manualCode !== null;
  const code = isManual ? manualCode : formatLotCode(prefix, number);

  // Choosing a prefix drops any number the user typed for the previous one:
  // "06" was the next A, and it is not necessarily the next B.
  const choosePrefix = (value: string) => {
    setPrefixOverride(value);
    setNumberOverride(null);
  };

  // Caught here as well as on the server so the user sees it before saving.
  const duplicate = codesInProject.some(
    (existing) => existing.toUpperCase() === code.trim().toUpperCase(),
  );

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    const price = parseMoneyInput(basePrice);

    if (!code.trim()) {
      setError("El número de lote es obligatorio.");
      return;
    }
    if (!projectName.trim()) {
      setError("Elige el proyecto al que pertenece el lote.");
      return;
    }
    if (duplicate) {
      setError(`El lote ${code} ya existe en ${projectName}.`);
      return;
    }
    if (!areaIsUsable) {
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

    setSaving(true);

    try {
      await onCreate({
        code: code.trim(),
        projectName,
        // Converted here, at the boundary: past this point the area is square
        // metres, whatever the user typed it in.
        areaM2: toSquareMetres(areaValue, unit),
        basePriceCents: fromCurrencyUnits(price),
      });
    } catch (caught) {
      // The server checks the same rules independently — a duplicate code or a
      // permission refusal surfaces here.
      setError(caught instanceof Error ? caught.message : "No se pudo crear el lote.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog ariaLabel="Nuevo lote" onClose={onCancel}>
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow">Nuevo lote</p>
            <h2>{code || "Sin número"}</h2>
            <p className="modal-description">
              El lote nace disponible. El cliente y el estado se definen solos cuando se le
              registra un contrato.
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Cerrar">
            <IconClose />
          </button>
        </div>

        <div className="modal-form-grid">
          <div className="form-field full-width">
            <label htmlFor="new-lot-project">Proyecto</label>
            <select
              id="new-lot-project"
              value={projectName}
              onChange={(event) => {
                setProjectName(event.target.value);
                // The suggestion belongs to the project, so switching projects
                // hands the code fields back to it.
                setPrefixOverride(null);
                setNumberOverride(null);
              }}
            >
              {projectNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <span className="field-hint">
              El número de lote se sugiere a partir del último de este proyecto.
            </span>
          </div>

          {!isManual && (
            <div className="form-field full-width">
              <label htmlFor="new-lot-prefix">Lote</label>
              <div className="code-composer">
                <input
                  id="new-lot-prefix"
                  className="code-prefix-input"
                  value={prefix}
                  maxLength={4}
                  aria-label="Letra del lote"
                  onChange={(event) => choosePrefix(event.target.value.toUpperCase())}
                />
                <span className="code-separator" aria-hidden="true">
                  -
                </span>
                <input
                  id="new-lot-number"
                  className="code-number-input"
                  value={number}
                  inputMode="numeric"
                  aria-label="Número del lote"
                  onChange={(event) => setNumberOverride(event.target.value)}
                />
                <span className="code-preview" aria-live="polite">
                  {code}
                </span>
              </div>

              {knownPrefixes.length > 0 && (
                <div className="code-prefix-chips">
                  <span className="field-hint">En este proyecto:</span>
                  {knownPrefixes.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={option === prefix ? "chip active" : "chip"}
                      onClick={() => choosePrefix(option)}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              )}

              <span className="field-hint">
                Puedes cambiar la letra y el número libremente.{" "}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => setManualCode(code)}
                >
                  Escribir el ID manualmente
                </button>
              </span>
            </div>
          )}

          {isManual && (
            <div className="form-field full-width">
              <label htmlFor="new-lot-code">Lote</label>
              <input
                id="new-lot-code"
                value={manualCode}
                onChange={(event) => setManualCode(event.target.value)}
              />
              <span className="field-hint">
                ID libre, sin sugerencias.{" "}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => setManualCode(null)}
                >
                  Volver a letra y número
                </button>
              </span>
            </div>
          )}

          {duplicate && code.trim() && (
            <p className="form-error full-width">
              El lote {code} ya existe en {projectName}.
            </p>
          )}

          <div className="form-field">
            <label htmlFor="new-lot-area">Área</label>
            <div className="input-with-suffix">
              <input
                id="new-lot-area"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={area}
                onChange={(event) => setArea(event.target.value)}
              />
              <span className="unit-suffix">{unitInfo.symbol}</span>
            </div>
            <span className="field-hint">
              {unitInfo.label}, la unidad de {projectName}.
              {areaIsUsable && unit !== "m2" && (
                <>
                  {" "}
                  Se guardan{" "}
                  <strong>
                    {new Intl.NumberFormat("es-HN", { maximumFractionDigits: 2 }).format(
                      toSquareMetres(areaValue, unit),
                    )}{" "}
                    m²
                  </strong>
                  .
                </>
              )}
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="new-lot-price">Precio base</label>
            <MoneyInput
              id="new-lot-price"
              value={basePrice}
              onChange={setBasePrice}
              placeholder="0.00"
            />
            <span className="field-hint">Siempre en lempiras.</span>
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
            disabled={isSaving || duplicate}
          >
            <span>{isSaving ? "Creando…" : "Crear lote"}</span>
          </button>
        </div>
      </form>
    </Dialog>
  );
}
