import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import { MoneyInput } from "../../components/MoneyInput";
import type { MoneyView } from "../../lib/money";
import {
  formatMoney,
  fromCurrencyUnits,
  parseMoneyInput,
  toMoneyInput,
} from "../../lib/money";
import type { Contract, HoldingKind, SaleType } from "../../types";
import type { ContractTermsDraft } from "./api";
import { KIND_LABELS, SALE_TYPE_LABELS, formatDate } from "./contractPresentation";
import { parseIntOrNull } from "./contractSchedule";

const MINIMUM_REASON_LENGTH = 10;

interface ContractEditDialogProps {
  contract: Contract;
  money: MoneyView;
  /**
   * Whether this user may move the sale price.
   *
   * A separate switch from being allowed to edit at all: changing a due day and
   * changing what somebody owes are different powers, and an owner may well
   * hand over the first without the second. The server enforces the same split
   * — locking the field here only spares the user a refused save.
   */
  canReprice: boolean;
  onCancel: () => void;
  /** Rejects when the server refuses; the message is shown in the dialog. */
  onSave: (draft: ContractTermsDraft) => Promise<void>;
}

/**
 * Correcting the terms of a signed contract.
 *
 * Every edit here demands a written motive, which is not how the lot and
 * customer forms behave — and the difference is deliberate. A lot's area is a
 * FACT somebody is fixing. A contract's terms are an AGREEMENT two people
 * signed, so "who moved the plazo from 24 months to 30, and why?" is a question
 * that gets asked months later, long after whoever typed it has forgotten.
 *
 * What cannot be changed here is the lot and the customer. A different lot is a
 * different sale, so it is a new contract and a cancellation, not an edit.
 */
export function ContractEditDialog({
  contract,
  money,
  canReprice,
  onCancel,
  onSave,
}: ContractEditDialogProps) {
  const [kind, setKind] = useState<HoldingKind>(contract.kind);
  const [saleType, setSaleType] = useState<SaleType>(contract.saleType);
  const [salePrice, setSalePrice] = useState(() => toMoneyInput(contract.terms.salePrice));
  const [downPayment, setDownPayment] = useState(() => toMoneyInput(contract.terms.downPayment));
  const [termMonths, setTermMonths] = useState(
    contract.terms.termMonths === null ? "" : String(contract.terms.termMonths),
  );
  const [monthlyPayment, setMonthlyPayment] = useState(() =>
    contract.terms.monthlyPayment === null ? "" : toMoneyInput(contract.terms.monthlyPayment),
  );
  const [dueDay, setDueDay] = useState(
    contract.terms.dueDay === null ? "" : String(contract.terms.dueDay),
  );
  const [signedOn, setSignedOn] = useState(contract.terms.signedOn);
  // The NEGOTIATED first due date, not the computed one. Binding to the
  // computed value would write it into the column and pin it there, so a later
  // correction to the signing date would stop moving the schedule with it.
  const [firstDueOn, setFirstDueOn] = useState(contract.terms.firstDueOnAgreed ?? "");
  const [expiresOn, setExpiresOn] = useState(contract.terms.expiresOn ?? "");
  const [notes, setNotes] = useState(contract.notes ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  const isFinanced = saleType === "financed";
  const isReservation = kind === "reservation";

  const priceCents = fromCurrencyUnits(parseMoneyInput(salePrice) || 0);
  const isRepricing = priceCents !== contract.terms.salePrice;
  // Locked rather than hidden: somebody who cannot change the price still has
  // to see what it is to make sense of everything else on the form.
  const priceLocked = !canReprice;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    const price = parseMoneyInput(salePrice);
    const down = parseMoneyInput(downPayment);
    const months = parseIntOrNull(termMonths);
    const monthly = monthlyPayment.trim() === "" ? null : parseMoneyInput(monthlyPayment);
    const day = parseIntOrNull(dueDay);

    if (!Number.isFinite(price) || price < 0) {
      setError("Escribe el precio de venta en lempiras.");
      return;
    }
    if (!Number.isFinite(down) || down < 0) {
      setError("Escribe la prima en lempiras.");
      return;
    }
    if (down > price) {
      setError("La prima no puede ser mayor que el precio de venta.");
      return;
    }

    // The same relationships the server checks in `termsProblem`, mirrored here
    // so a mistake is caught before the round trip rather than after it.
    if (isFinanced) {
      if (months === null || !Number.isFinite(months) || months < 1) {
        setError("Un contrato a crédito necesita el plazo en meses.");
        return;
      }
      if (monthly === null || !Number.isFinite(monthly) || monthly <= 0) {
        setError("Un contrato a crédito necesita la cuota mensual.");
        return;
      }
      if (day === null || !Number.isFinite(day) || day < 1 || day > 31) {
        setError("El día de pago debe estar entre 1 y 31.");
        return;
      }
      if (down === price) {
        setError("Si la prima cubre todo el precio, la venta es de contado, no a crédito.");
        return;
      }
    }
    // No matching `else` refusing a stray plazo, cuota or día de pago, which is
    // what the server checks for. Those three fields, and the primera cuota
    // below, only EXIST on this form while the sale is financed — so a contract
    // switched from crédito to contado still holds the old values in state with
    // nothing on screen to clear them by, and an error about an invisible field
    // is an error nobody can act on. They are sent as null instead.

    if (saleType === "donation" && (price > 0 || down > 0)) {
      setError("Una donación se registra con precio y prima en cero.");
      return;
    }
    if (isReservation && expiresOn.trim() === "") {
      setError("Una reserva necesita una fecha de vencimiento.");
      return;
    }
    if (isFinanced && firstDueOn.trim() !== "" && firstDueOn < signedOn) {
      setError("La primera cuota no puede vencer antes de firmar el contrato.");
      return;
    }
    if (isReservation && expiresOn.trim() !== "" && expiresOn < signedOn) {
      setError("El vencimiento de la reserva no puede ser anterior a la firma.");
      return;
    }
    if (fromCurrencyUnits(price) < contract.paidToDate) {
      setError(
        `Este contrato ya tiene ${formatMoney(contract.paidToDate, money)} pagados. ` +
          "El precio no puede quedar por debajo de esa cifra.",
      );
      return;
    }
    if (reason.trim().length < MINIMUM_REASON_LENGTH) {
      setError(`Explica el motivo con al menos ${MINIMUM_REASON_LENGTH} caracteres.`);
      return;
    }

    setSaving(true);

    try {
      await onSave({
        kind,
        saleType,
        salePriceCents: fromCurrencyUnits(price),
        downPaymentCents: fromCurrencyUnits(down),
        termMonths: isFinanced ? months : null,
        monthlyPaymentCents: isFinanced && monthly !== null ? fromCurrencyUnits(monthly) : null,
        dueDay: isFinanced ? day : null,
        signedOn,
        // Blank means "let it follow from the signing date", which is a
        // different instruction from any particular date.
        firstDueOn: isFinanced && firstDueOn.trim() !== "" ? firstDueOn : null,
        expiresOn: isReservation && expiresOn.trim() !== "" ? expiresOn : null,
        notes: notes.trim() === "" ? null : notes.trim(),
        reason: reason.trim(),
      });
    } catch (caught) {
      // The server checks every one of these rules independently, so this is
      // where a permission refusal surfaces too.
      setError(caught instanceof Error ? caught.message : "No se pudo guardar el contrato.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog ariaLabel={`Editar contrato ${contract.code}`} onClose={onCancel}>
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow">Editar contrato</p>
            <h2>{contract.code}</h2>
            <p className="modal-description">
              {contract.customer.fullName} · Lote {contract.lot.code} ·{" "}
              {contract.lot.projectName}
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Cerrar">
            <IconClose />
          </button>
        </div>

        <div className="modal-form-grid">
          {/* Said before anything is typed. The lot and the customer are the
              two things this form cannot move, and somebody who opened it to
              fix the wrong lot should find that out now rather than after
              filling in nine fields. */}
          <p className="form-blocked full-width">
            El lote y el cliente no se cambian aquí: un lote distinto es otra venta, no una
            corrección. Todo lo demás queda registrado en el Historial con tu nombre, la fecha y
            el motivo que escribas abajo.
          </p>

          <div className="form-field">
            <label htmlFor="contract-kind">Tipo</label>
            <select
              id="contract-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as HoldingKind)}
            >
              {(Object.keys(KIND_LABELS) as HoldingKind[]).map((value) => (
                <option key={value} value={value}>
                  {KIND_LABELS[value]}
                </option>
              ))}
            </select>
            <span className="field-hint">Una reserva es un apartado; un contrato es la venta.</span>
          </div>

          <div className="form-field">
            <label htmlFor="contract-sale-type">Forma de pago</label>
            <select
              id="contract-sale-type"
              value={saleType}
              onChange={(event) => setSaleType(event.target.value as SaleType)}
            >
              {(Object.keys(SALE_TYPE_LABELS) as SaleType[]).map((value) => (
                <option key={value} value={value}>
                  {SALE_TYPE_LABELS[value]}
                </option>
              ))}
            </select>
            <span className="field-hint">
              Solo el crédito lleva plazo, cuota y día de pago.
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="contract-price">Precio de venta</label>
            <MoneyInput
              id="contract-price"
              value={salePrice}
              onChange={setSalePrice}
              readOnly={priceLocked}
            />
            <span className="field-hint">
              {priceLocked
                ? "Tu usuario no puede cambiar el precio de un contrato. Pídeselo a un supervisor."
                : "Es el precio de ESTA venta, independiente del precio de lista del lote."}
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="contract-down">Prima acordada</label>
            <MoneyInput id="contract-down" value={downPayment} onChange={setDownPayment} />
            <span className="field-hint">
              Lo acordado, no lo cobrado. Van {formatMoney(contract.downPaymentPaid, money)}{" "}
              recibidos.
            </span>
          </div>

          {isFinanced && (
            <>
              <div className="form-field">
                <label htmlFor="contract-term">Plazo en meses</label>
                <input
                  id="contract-term"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="600"
                  value={termMonths}
                  onChange={(event) => setTermMonths(event.target.value)}
                />
              </div>

              <div className="form-field">
                <label htmlFor="contract-monthly">Cuota mensual</label>
                <MoneyInput
                  id="contract-monthly"
                  value={monthlyPayment}
                  onChange={setMonthlyPayment}
                />
                <span className="field-hint">
                  La cuota que se negoció. La última absorbe la diferencia del redondeo.
                </span>
              </div>

              <div className="form-field">
                <label htmlFor="contract-due-day">Día de pago</label>
                <input
                  id="contract-due-day"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="31"
                  value={dueDay}
                  onChange={(event) => setDueDay(event.target.value)}
                />
                <span className="field-hint">
                  Los meses cortos se ajustan solos: el 31 vence el 28 en febrero.
                </span>
              </div>
            </>
          )}

          <div className="form-field">
            <label htmlFor="contract-signed">Fecha de firma</label>
            <input
              id="contract-signed"
              type="date"
              value={signedOn}
              onChange={(event) => setSignedOn(event.target.value)}
            />
            <span className="field-hint">Desde aquí cuenta el calendario de pagos.</span>
          </div>

          {isFinanced && (
            <div className="form-field">
              <label htmlFor="contract-first-due">Primera cuota</label>
              <input
                id="contract-first-due"
                type="date"
                value={firstDueOn}
                onChange={(event) => setFirstDueOn(event.target.value)}
              />
              <span className="field-hint">
                {firstDueOn.trim() === "" && contract.terms.firstDueOn
                  ? `Opcional. Sin fecha, vence el ${formatDate(contract.terms.firstDueOn)}, un mes después de firmar.`
                  : "Solo si se negoció aparte. Déjalo vacío para contar un mes desde la firma."}
              </span>
            </div>
          )}

          {isReservation && (
            <div className="form-field">
              <label htmlFor="contract-expires">
                Vence la reserva<span className="required-mark" aria-hidden="true"> *</span>
              </label>
              <input
                id="contract-expires"
                type="date"
                value={expiresOn}
                onChange={(event) => setExpiresOn(event.target.value)}
              />
              <span className="field-hint">
                Un apartado sin fecha deja el lote fuera del mercado para siempre.
              </span>
            </div>
          )}

          <div className="form-field full-width">
            <label htmlFor="contract-notes">Notas</label>
            <textarea
              id="contract-notes"
              rows={2}
              value={notes}
              placeholder="Ej. Paga por transferencia los primeros días del mes."
              onChange={(event) => setNotes(event.target.value)}
            />
            <span className="field-hint">
              Se ve en la lista de contratos, debajo del nombre del cliente.
            </span>
          </div>

          {/* Only once the price has actually moved, and only when there is
              money behind it. A warning that is always on screen is a warning
              nobody reads. */}
          {isRepricing && contract.paidToDate > 0 && (
            <p className="form-warning full-width">
              Este contrato ya tiene {formatMoney(contract.paidToDate, money)} pagados. Cambiar el
              precio cambia el saldo de {contract.customer.fullName} de inmediato, y no mueve ni
              devuelve un solo pago.
            </p>
          )}

          <div className="form-field full-width">
            <label htmlFor="contract-reason">
              Motivo del cambio<span className="required-mark" aria-hidden="true"> *</span>
            </label>
            <textarea
              id="contract-reason"
              rows={3}
              value={reason}
              placeholder="Ej. El contrato firmado dice día 15; se capturó día 5 por error."
              onChange={(event) => setReason(event.target.value)}
            />
            <span className="field-hint">
              Obligatorio en todos los cambios: esto es lo que se firmó, no un dato que se
              corrige sin más.
            </span>
          </div>

          {error && <p className="form-error full-width">{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={isSaving}>
            Cancelar
          </button>
          <button type="submit" className="btn-primary modal-submit" disabled={isSaving}>
            <span>{isSaving ? "Guardando…" : "Guardar cambios"}</span>
          </button>
        </div>
      </form>
    </Dialog>
  );
}
