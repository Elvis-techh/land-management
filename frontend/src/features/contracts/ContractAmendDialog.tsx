import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import { MoneyInput } from "../../components/MoneyInput";
import { businessToday } from "../../lib/businessTime";
import type { MoneyView } from "../../lib/money";
import { cents, formatMoney, fromCurrencyUnits, parseMoneyInput, toMoneyInput } from "../../lib/money";
import type { Contract } from "../../types";
import type { AmendmentDraft } from "./api";
import type { SplitMode } from "./amendmentMath";
import { nextAmendedCode, planAmendment } from "./amendmentMath";
import { SALE_TYPE_LABELS, formatDate } from "./contractPresentation";
import { clampDueDayInput, firstDueDate, parseIntOrNull, summarizeSchedule } from "./contractSchedule";

const MINIMUM_REASON_LENGTH = 10;

const SPLIT_OPTIONS: Array<{ value: SplitMode; title: string; detail: string }> = [
  { value: "equal", title: "Partes iguales", detail: "El mismo precio para cada lote." },
  { value: "area", title: "Según el área", detail: "En proporción a los metros de cada lote." },
  { value: "manual", title: "A mano", detail: "Escribes el precio de cada lote." },
];

interface ContractAmendDialogProps {
  /** The running contracts the adenda can cover — one purchase, all vigentes. */
  contracts: Contract[];
  /** Every contract number on file, to foresee the ones the new contracts get. */
  existingCodes: string[];
  money: MoneyView;
  onCancel: () => void;
  /** Rejects when the server refuses; the message is shown in the dialog. */
  onSave: (draft: AmendmentDraft) => Promise<void>;
}

/** A money field's value in centavos, zero when blank or unreadable. */
function centsOf(text: string): number {
  const value = parseMoneyInput(text);
  return Number.isFinite(value) && value > 0 ? fromCurrencyUnits(value) : 0;
}

/** "320", "338.58" — an area as it is read aloud, not as it is stored. */
function formatArea(areaM2: number): string {
  return areaM2.toLocaleString("es-HN", { maximumFractionDigits: 2 });
}

/**
 * An adenda: new terms for contracts that are already running.
 *
 * The screen that answers "the customer and the owner agreed something new" —
 * a new total for the whole purchase, a new plazo — without pretending the old
 * agreement never happened. Nothing here edits a contract. Saving closes the
 * chosen contracts as «Reemplazado», with every payment and every receipt left
 * exactly as it was, and opens new contracts on the same lots with the terms
 * below. The money paid under the old terms stays with the old contracts as
 * income, which is the deal being recorded: kept, not refunded, and not
 * credited to the new price.
 *
 * The agreement is typed the way it was made — one total, one plazo, one day
 * of the month — and the dialog does the division between the lots, in the
 * open, before anything is saved. That is the half of this screen that replaces
 * a calculator and a sheet of paper.
 */
export function ContractAmendDialog({
  contracts,
  existingCodes,
  money,
  onCancel,
  onSave,
}: ContractAmendDialogProps) {
  const customerName = contracts[0]?.customer.fullName ?? "";
  // The día de pago carries over when the lots already share one, which they
  // do whenever they were bought together.
  const sharedDueDay =
    new Set(contracts.map((contract) => contract.terms.dueDay)).size === 1
      ? (contracts[0]?.terms.dueDay ?? null)
      : null;
  const [initialToday] = useState(() => businessToday());

  const [included, setIncluded] = useState<ReadonlySet<string>>(
    () => new Set(contracts.map((contract) => contract.id)),
  );
  const [effectiveOn, setEffectiveOn] = useState(initialToday);
  const [authorizedBy, setAuthorizedBy] = useState("");
  const [total, setTotal] = useState("");
  const [mode, setMode] = useState<SplitMode>("equal");
  const [manualPrices, setManualPrices] = useState<Record<string, string>>({});
  const [saleType, setSaleType] = useState<"financed" | "cash">("financed");
  const [downPayment, setDownPayment] = useState("");
  const [termMonths, setTermMonths] = useState("");
  const [dueDay, setDueDay] = useState(sharedDueDay === null ? "" : String(sharedDueDay));
  const [firstDueOn, setFirstDueOn] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  const chosen = contracts.filter((contract) => included.has(contract.id));
  const isFinanced = saleType === "financed";
  const months = parseIntOrNull(termMonths);
  const day = parseIntOrNull(dueDay);
  const validMonths = months !== null && Number.isFinite(months) && months >= 1 ? months : null;
  const validDay = day !== null && Number.isFinite(day) && day >= 1 && day <= 31 ? day : null;

  const plan = planAmendment({
    mode,
    totalCents: centsOf(total),
    downPaymentTotalCents: isFinanced ? centsOf(downPayment) : 0,
    lots: chosen.map((contract) => ({
      areaM2: contract.lot.areaM2,
      manualPriceCents:
        manualPrices[contract.id] === undefined || manualPrices[contract.id]!.trim() === ""
          ? Number.NaN
          : centsOf(manualPrices[contract.id]!),
    })),
    financed: isFinanced,
    termMonths: validMonths,
  });
  const lineFor = (contractId: string) => {
    const index = chosen.findIndex((contract) => contract.id === contractId);
    return index === -1 ? null : (plan.lines[index] ?? null);
  };

  // The first cuota as the server will derive it when none is typed: a month
  // after the agreement, on the día de pago.
  const derivedFirstDue =
    validDay !== null && effectiveOn !== "" ? firstDueDate(effectiveOn, validDay, null) : null;
  const firstDue = firstDueOn.trim() !== "" ? firstDueOn : derivedFirstDue;

  const paidBefore = chosen.reduce((sum, contract) => sum + contract.paidToDate, 0);
  const oldTotal = chosen.reduce((sum, contract) => sum + contract.terms.salePrice, 0);
  const downTotal = plan.lines.reduce((sum, line) => sum + line.downPaymentCents, 0);
  const financedTotal = plan.lines.reduce((sum, line) => sum + line.financedCents, 0);
  const monthlyTotal = plan.lines.reduce((sum, line) => sum + (line.monthlyPaymentCents ?? 0), 0);
  const latestSigning = chosen.reduce(
    (latest, contract) => (contract.terms.signedOn > latest ? contract.terms.signedOn : latest),
    "",
  );
  const newCodes = chosen.map((contract) => nextAmendedCode(contract.code, existingCodes));

  const isDirty =
    effectiveOn !== initialToday ||
    authorizedBy.trim() !== "" ||
    total.trim() !== "" ||
    mode !== "equal" ||
    saleType !== "financed" ||
    downPayment.trim() !== "" ||
    termMonths.trim() !== "" ||
    dueDay !== (sharedDueDay === null ? "" : String(sharedDueDay)) ||
    firstDueOn !== "" ||
    reason.trim() !== "" ||
    included.size !== contracts.length;

  /*
   * Moving to "a mano" starts from the prices already on screen rather than
   * from blanks, so adjusting one lot by a few lempiras is one edit instead of
   * three. Leaving it keeps the total that was built by hand.
   */
  const chooseMode = (next: SplitMode) => {
    if (next === mode) {
      return;
    }

    if (next === "manual") {
      setManualPrices(
        Object.fromEntries(
          chosen.map((contract) => {
            const price = lineFor(contract.id)?.salePriceCents ?? 0;
            return [contract.id, price > 0 ? toMoneyInput(cents(price)) : ""];
          }),
        ),
      );
    } else if (mode === "manual" && plan.totalCents > 0) {
      setTotal(toMoneyInput(cents(plan.totalCents)));
    }

    setMode(next);
  };

  const toggleIncluded = (contractId: string) => {
    setIncluded((current) => {
      const next = new Set(current);
      if (!next.delete(contractId)) {
        next.add(contractId);
      }
      return next;
    });
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (chosen.length === 0) {
      setError("Elige al menos un lote para la adenda.");
      return;
    }
    if (effectiveOn === "") {
      setError("Escribe la fecha en que se acordó.");
      return;
    }
    if (effectiveOn > businessToday()) {
      setError("La fecha de la adenda no puede ser futura: es el día en que se acordó.");
      return;
    }
    if (effectiveOn < latestSigning) {
      setError(`La adenda no puede ser anterior a la firma (${formatDate(latestSigning)}).`);
      return;
    }
    if (mode !== "manual" && centsOf(total) === 0) {
      setError("Escribe el precio total del nuevo acuerdo.");
      return;
    }
    if (plan.lines.some((line) => line.salePriceCents <= 0)) {
      setError("Cada lote necesita un precio mayor que cero.");
      return;
    }
    if (isFinanced) {
      if (validMonths === null) {
        setError("Un acuerdo a crédito necesita el plazo en meses.");
        return;
      }
      if (validDay === null) {
        setError("El día de pago debe estar entre 1 y 31.");
        return;
      }
      if (plan.lines.some((line) => line.downPaymentCents >= line.salePriceCents)) {
        setError("La prima no puede cubrir todo el precio: eso sería una venta de contado.");
        return;
      }
      if (firstDueOn.trim() !== "" && firstDueOn < effectiveOn) {
        setError("La primera cuota no puede vencer antes de la fecha del acuerdo.");
        return;
      }
    }
    if (reason.trim().length < MINIMUM_REASON_LENGTH) {
      setError(`Explica el motivo con al menos ${MINIMUM_REASON_LENGTH} caracteres.`);
      return;
    }

    setSaving(true);

    try {
      await onSave({
        effectiveOn,
        saleType,
        termMonths: isFinanced ? validMonths : null,
        dueDay: isFinanced ? validDay : null,
        // Blank means "a month after the agreement", which the server works
        // out itself — a different instruction from any particular date.
        firstDueOn: isFinanced && firstDueOn.trim() !== "" ? firstDueOn : null,
        lines: chosen.map((contract, index) => ({
          contractId: contract.id,
          salePriceCents: plan.lines[index]!.salePriceCents,
          downPaymentCents: plan.lines[index]!.downPaymentCents,
          monthlyPaymentCents: plan.lines[index]!.monthlyPaymentCents,
        })),
        authorizedBy: authorizedBy.trim() === "" ? null : authorizedBy.trim(),
        reason: reason.trim(),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo registrar la adenda.");
    } finally {
      setSaving(false);
    }
  };

  const oldCodes = chosen.map((contract) => contract.code).join(", ");

  return (
    <Dialog
      ariaLabel={`Adenda para ${customerName}`}
      size="wide"
      // Twenty figures agreed with a customer. The X and Cancelar are the way
      // out; a stray click on the backdrop is not.
      dismissible={!isDirty && !isSaving}
      onClose={onCancel}
    >
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow">Adenda · nuevo acuerdo</p>
            <h2>{customerName}</h2>
            <p className="modal-description">
              {contracts.length === 1
                ? `Lote ${contracts[0]!.lot.code} · ${contracts[0]!.code}`
                : `${contracts.length} lotes de una sola compra`}{" "}
              · hoy {formatMoney(cents(oldTotal), money)}, pagado{" "}
              {formatMoney(cents(paidBefore), money)}
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Cerrar">
            <IconClose />
          </button>
        </div>

        <div className="modal-form-grid">
          {/* Said before anything is typed: what this does to the contracts
              that exist, and what becomes of the money already paid. */}
          <p className="form-blocked full-width">
            Una adenda no edita los contratos: los cierra como «Reemplazado», con sus pagos y
            recibos tal como están, y abre contratos nuevos en los mismos lotes con lo que se
            acuerde abajo. Lo ya pagado ({formatMoney(cents(paidBefore), money)}) queda como
            ingreso: no se devuelve ni se abona al nuevo precio.
          </p>

          <div className="form-field">
            <label htmlFor="amend-date">
              Fecha del acuerdo<span className="required-mark" aria-hidden="true"> *</span>
            </label>
            <input
              id="amend-date"
              type="date"
              value={effectiveOn}
              max={initialToday}
              onChange={(event) => setEffectiveOn(event.target.value)}
            />
            <span className="field-hint">
              El día en que se acordó. Los contratos nuevos se firman con esta fecha, y los pagos
              del contrato anterior tienen que ser de ese día o de antes.
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="amend-authorized">Autorizó</label>
            <input
              id="amend-authorized"
              type="text"
              maxLength={120}
              value={authorizedBy}
              placeholder="Ej. Don Julio (dueño)"
              onChange={(event) => setAuthorizedBy(event.target.value)}
            />
            <span className="field-hint">Quién aprobó el nuevo trato. Opcional.</span>
          </div>

          <div className="form-field">
            <label htmlFor="amend-total">
              Precio total nuevo<span className="required-mark" aria-hidden="true"> *</span>
            </label>
            <MoneyInput
              id="amend-total"
              value={mode === "manual" ? toMoneyInput(cents(plan.totalCents)) : total}
              onChange={setTotal}
              placeholder="Ej. 800,000"
              readOnly={mode === "manual"}
            />
            <span className="field-hint">
              {mode === "manual"
                ? "La suma de los precios que escribas en cada lote."
                : chosen.length === 1
                  ? "El nuevo precio de este lote."
                  : `El precio de los ${chosen.length} lotes juntos.`}
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="amend-sale-type">Forma de pago</label>
            <select
              id="amend-sale-type"
              value={saleType}
              onChange={(event) => setSaleType(event.target.value as "financed" | "cash")}
            >
              <option value="financed">{SALE_TYPE_LABELS.financed}</option>
              <option value="cash">{SALE_TYPE_LABELS.cash}</option>
            </select>
            <span className="field-hint">
              {isFinanced
                ? "Prima y cuotas en las fechas de abajo."
                : "Todo el nuevo precio de una vez, sin cuotas."}
            </span>
          </div>

          {chosen.length > 1 && (
            <fieldset className="form-field full-width settlement-choice">
              <legend>Repartir el precio entre los lotes</legend>
              <div className="amend-split-choice">
                {SPLIT_OPTIONS.map((option) => (
                  <label key={option.value} className="settlement-option">
                    <input
                      type="radio"
                      name="amend-split"
                      value={option.value}
                      checked={mode === option.value}
                      onChange={() => chooseMode(option.value)}
                    />
                    <span>
                      <span className="settlement-title">{option.title}</span>
                      <span className="settlement-detail">{option.detail}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {isFinanced && (
            <>
              <div className="form-field">
                <label htmlFor="amend-down">Prima del nuevo acuerdo</label>
                <MoneyInput
                  id="amend-down"
                  value={downPayment}
                  onChange={setDownPayment}
                  placeholder="Ej. 150,000"
                />
                <span className="field-hint">
                  Lo que entrega al cerrar el trato — si ya mandó dinero para este acuerdo, va aquí
                  y las cuotas se calculan sobre el resto. Esos pagos se registran después, como
                  recibos normales, en los contratos nuevos.
                </span>
              </div>

              <div className="form-field">
                <label htmlFor="amend-term">
                  Plazo en meses<span className="required-mark" aria-hidden="true"> *</span>
                </label>
                <input
                  id="amend-term"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="600"
                  value={termMonths}
                  placeholder="Ej. 3"
                  onChange={(event) => setTermMonths(event.target.value)}
                />
              </div>

              <div className="form-field">
                <label htmlFor="amend-due-day">
                  Día de pago<span className="required-mark" aria-hidden="true"> *</span>
                </label>
                <input
                  id="amend-due-day"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="31"
                  value={dueDay}
                  onChange={(event) => setDueDay(clampDueDayInput(event.target.value))}
                />
              </div>

              <div className="form-field">
                <label htmlFor="amend-first-due">Primera cuota</label>
                <input
                  id="amend-first-due"
                  type="date"
                  value={firstDueOn}
                  min={effectiveOn || undefined}
                  onChange={(event) => setFirstDueOn(event.target.value)}
                />
                <span className="field-hint">
                  {firstDueOn.trim() === "" && derivedFirstDue
                    ? `Opcional. Sin fecha, vence el ${formatDate(derivedFirstDue)}, un mes después del acuerdo.`
                    : "Solo si se negoció aparte."}
                </span>
              </div>
            </>
          )}

          <div className="form-field full-width">
            <span className="amend-table-title">Cómo queda cada lote</span>
            <div className="amend-table-scroll">
              <table className="amend-table">
                <thead>
                  <tr>
                    <th>Lote</th>
                    <th>Ahora</th>
                    <th className="col-money">Nuevo precio</th>
                    {isFinanced && <th className="col-money">Prima</th>}
                    <th>{isFinanced ? "Cuotas" : "Contrato nuevo"}</th>
                  </tr>
                </thead>
                <tbody>
                  {contracts.map((contract) => {
                    const line = lineFor(contract.id);
                    const index = chosen.findIndex((candidate) => candidate.id === contract.id);
                    const schedule =
                      line && isFinanced && validMonths !== null && validDay !== null && firstDue
                        ? summarizeSchedule(
                            line.financedCents,
                            validMonths,
                            line.monthlyPaymentCents ?? 0,
                            firstDue,
                            validDay,
                          )
                        : null;

                    return (
                      <tr key={contract.id} className={line ? undefined : "is-excluded"}>
                        <td data-label="Lote">
                          {contracts.length > 1 ? (
                            <label className="amend-include">
                              <input
                                type="checkbox"
                                checked={included.has(contract.id)}
                                onChange={() => toggleIncluded(contract.id)}
                                aria-label={`Incluir el lote ${contract.lot.code}`}
                              />
                              <span className="code-badge">{contract.lot.code}</span>
                            </label>
                          ) : (
                            <span className="code-badge">{contract.lot.code}</span>
                          )}
                          <span className="cell-sub">{formatArea(contract.lot.areaM2)} m²</span>
                        </td>
                        <td data-label="Ahora">
                          <span className="cell-money">
                            {formatMoney(contract.terms.salePrice, money)}
                          </span>
                          <span className="cell-sub">
                            {contract.code} · pagado {formatMoney(contract.paidToDate, money)}
                          </span>
                        </td>
                        <td data-label="Nuevo precio" className="col-money">
                          {!line ? (
                            <span className="cell-sub">Sigue igual</span>
                          ) : mode === "manual" ? (
                            <MoneyInput
                              id={`amend-price-${contract.id}`}
                              value={manualPrices[contract.id] ?? ""}
                              onChange={(value) =>
                                setManualPrices((current) => ({ ...current, [contract.id]: value }))
                              }
                              placeholder="Precio"
                            />
                          ) : (
                            <span className="cell-money">
                              {formatMoney(cents(line.salePriceCents), money)}
                            </span>
                          )}
                          {line && <span className="cell-sub">{newCodes[index]}</span>}
                        </td>
                        {isFinanced && (
                          <td data-label="Prima" className="col-money">
                            {line && (
                              <span className="cell-money">
                                {formatMoney(cents(line.downPaymentCents), money)}
                              </span>
                            )}
                          </td>
                        )}
                        <td data-label={isFinanced ? "Cuotas" : "Contrato nuevo"}>
                          {!line ? null : !isFinanced ? (
                            <span className="cell-sub">{newCodes[index]} · de contado</span>
                          ) : schedule && line.monthlyPaymentCents !== null ? (
                            <>
                              <span className="cell-money">
                                {schedule.count} ×{" "}
                                {formatMoney(cents(line.monthlyPaymentCents), money)}
                              </span>
                              <span className="cell-sub">
                                {schedule.lastAmountCents !== line.monthlyPaymentCents
                                  ? `la última ${formatMoney(cents(schedule.lastAmountCents), money)}, `
                                  : ""}
                                hasta {formatDate(schedule.lastDueOn)}
                              </span>
                            </>
                          ) : (
                            <span className="cell-sub">Falta el plazo</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {chosen.length > 0 && plan.totalCents > 0 && (
              <p className="field-hint amend-total-line">
                Nuevo total {formatMoney(cents(plan.totalCents), money)}
                {isFinanced && downTotal > 0 && ` · prima ${formatMoney(cents(downTotal), money)}`}
                {isFinanced &&
                  validMonths !== null &&
                  ` · ${formatMoney(cents(financedTotal), money)} en ${validMonths} ${
                    validMonths === 1 ? "cuota" : "cuotas"
                  } de unos ${formatMoney(cents(monthlyTotal), money)} al mes`}
                . Se cierran {oldCodes} y se abren {newCodes.join(", ")}.
              </p>
            )}
          </div>

          <div className="form-field full-width">
            <label htmlFor="amend-reason">
              Motivo<span className="required-mark" aria-hidden="true"> *</span>
            </label>
            <textarea
              id="amend-reason"
              rows={3}
              value={reason}
              placeholder="Ej. Pagará los 3 lotes antes de fin de año; se acordó un precio total de L 800,000."
              onChange={(event) => setReason(event.target.value)}
            />
            <span className="field-hint">
              Queda en los contratos nuevos y en los reemplazados, y en el Historial.
            </span>
          </div>

          {error && <p className="form-error full-width">{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={isSaving}>
            Cancelar
          </button>
          <button type="submit" className="btn-primary modal-submit" disabled={isSaving}>
            <span>{isSaving ? "Registrando…" : "Registrar adenda"}</span>
          </button>
        </div>
      </form>
    </Dialog>
  );
}
