import { useCallback, useEffect, useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import { MoneyInput } from "../../components/MoneyInput";
import { businessToday } from "../../lib/businessTime";
import type { MoneyView } from "../../lib/money";
import { cents, formatMoney, typedCents } from "../../lib/money";
import type { User } from "../../lib/permissions";
import { can } from "../../lib/permissions";
import type { Contract } from "../../types";
import type { ContractMora as ContractMoraData, ManualMora } from "./api";
import { chargeContractMora, fetchContractMora, removeContractMora } from "./api";
import { formatDate } from "./contractPresentation";

interface ContractMoraProps {
  contract: Contract;
  money: MoneyView;
  user: User;
  /** Re-read the contracts list: a mora moves the saldo and «Mora pendiente». */
  onChanged: () => void;
}

const MINIMUM_REASON = 10;

/** "Prima" or "Cuota 4", as the rest of the app names them. */
function itemName(installment: number): string {
  return installment === 0 ? "Prima" : `Cuota ${installment}`;
}

/** The day after an ISO date, for the earliest date a mora can carry. */
function dayAfter(isoDate: string): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * «Cargar mora»: mora put on this contract by hand, and the list of what was.
 *
 * For what the automatic mora never does, because it never charges backwards:
 * mora the customer paid before mora was switched on, and mora agreed for a
 * cuota that was late before «Desde». See GET /contracts/:id/mora.
 *
 * Fetched when the panel opens, like the documents: the contracts list only
 * needs the totals, which already include these.
 */
export function ContractMora({ contract, money, user, onChanged }: ContractMoraProps) {
  const [data, setData] = useState<ContractMoraData | null>(null);
  const [isCharging, setCharging] = useState(false);
  const [removing, setRemoving] = useState<ManualMora | null>(null);
  const canCharge = can(user, "mora:charge");

  const load = useCallback(() => {
    fetchContractMora(contract.id)
      .then(setData)
      // Nothing to show is the same as nothing put on by hand. The totals
      // above come from the list and are unaffected.
      .catch(() => setData(null));
  }, [contract.id]);

  // Also when the totals move (a payment from another tab), so «pagada» and
  // «pendiente» below keep up with «Mora pendiente» above.
  useEffect(load, [load, contract.mora.charged, contract.mora.paid]);

  if (data === null || (!data.chargeable && data.manual.length === 0)) {
    return null;
  }

  const afterChange = () => {
    load();
    onChanged();
  };

  return (
    <section className="cp-section">
      <div className="cp-docs-head">
        <h3 className="cp-section-title">Mora cargada a mano</h3>
        {canCharge && data.chargeable && data.due.length > 0 && (
          <button type="button" className="btn-secondary is-small" onClick={() => setCharging(true)}>
            Cargar mora
          </button>
        )}
      </div>

      {data.manual.length === 0 ? (
        <p className="cp-note">
          Ninguna. Para la mora que el cliente pagó o acordó antes de que la mora estuviera
          activada.
        </p>
      ) : (
        <ul className="cp-docs">
          {data.manual.map((entry) => (
            <li key={entry.id} className="cp-doc">
              <span className="cp-doc-meta">
                <span className="cp-doc-name">
                  {itemName(entry.installment)} · {formatDate(entry.incurredOn)} ·{" "}
                  {formatMoney(cents(entry.amountCents), money)}
                </span>
                <span className="cp-doc-sub is-prose">
                  {entry.pendingCents === 0
                    ? "Pagada"
                    : entry.pendingCents === entry.amountCents
                      ? "Pendiente"
                      : `Faltan ${formatMoney(cents(entry.pendingCents), money)}`}{" "}
                  · {entry.reason} · {entry.recordedBy}
                </span>
              </span>
              {canCharge && (
                <button
                  type="button"
                  className="link-btn is-danger"
                  onClick={() => setRemoving(entry)}
                  aria-label={`Quitar la mora de ${itemName(entry.installment).toLowerCase()}`}
                >
                  Quitar
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {isCharging && (
        <ChargeMoraDialog
          contract={contract}
          data={data}
          money={money}
          onClose={() => setCharging(false)}
          onCharged={() => {
            setCharging(false);
            afterChange();
          }}
        />
      )}

      {removing && (
        <RemoveMoraDialog
          contract={contract}
          entry={removing}
          money={money}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null);
            afterChange();
          }}
        />
      )}
    </section>
  );
}

interface ChargeMoraDialogProps {
  contract: Contract;
  data: ContractMoraData;
  money: MoneyView;
  onClose: () => void;
  onCharged: () => void;
}

/** The form itself: which cuota, which day, how much and why. */
function ChargeMoraDialog({ contract, data, money, onClose, onCharged }: ChargeMoraDialogProps) {
  const today = businessToday();
  // The most recent cuota first: the late one being talked about is usually the last.
  const options = [...data.due].reverse();
  const [installment, setInstallment] = useState(options[0]!.installment);
  const [incurredOn, setIncurredOn] = useState(today);
  const [amountText, setAmountText] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  const item = data.due.find((entry) => entry.installment === installment)!;
  const automatic = data.automaticByInstallment[installment] ?? 0;
  const amountCents = typedCents(amountText);
  const trimmedReason = reason.trim();
  const dateProblem =
    incurredOn === ""
      ? "Elige la fecha."
      : incurredOn <= item.dueOn
        ? `Tiene que ser después del ${formatDate(item.dueOn)}, cuando venció.`
        : incurredOn > today
          ? "No puede ser una fecha futura."
          : null;
  const canSubmit =
    amountCents > 0 && dateProblem === null && trimmedReason.length >= MINIMUM_REASON && !isSaving;

  const submit = async () => {
    setError(null);
    setSaving(true);

    try {
      await chargeContractMora(contract.id, { installment, incurredOn, amountCents, reason: trimmedReason });
      onCharged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo cargar la mora.");
      setSaving(false);
    }
  };

  return (
    <Dialog ariaLabel={`Cargar mora, contrato ${contract.code}`} onClose={onClose}>
      <div className="modal-header">
        <div>
          <p className="modal-eyebrow">Cargar mora</p>
          <h2>{contract.code}</h2>
          <p className="modal-description">
            {contract.customer.fullName} · Lote {contract.lot.code} · {contract.lot.projectName}
          </p>
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Cerrar">
          <IconClose />
        </button>
      </div>

      <div className="modal-form-grid">
        <div className="form-field">
          <label htmlFor="mora-installment">
            Cuota <span className="required-mark">*</span>
          </label>
          <select
            id="mora-installment"
            value={installment}
            onChange={(event) => setInstallment(Number(event.target.value))}
          >
            {options.map((entry) => (
              <option key={entry.installment} value={entry.installment}>
                {itemName(entry.installment)} · vencía {formatDate(entry.dueOn)}
              </option>
            ))}
          </select>
        </div>

        <div className="form-field">
          <label htmlFor="mora-date">
            Fecha <span className="required-mark">*</span>
          </label>
          <input
            id="mora-date"
            type="date"
            value={incurredOn}
            min={dayAfter(item.dueOn)}
            max={today}
            onChange={(event) => setIncurredOn(event.target.value)}
          />
          {dateProblem ? (
            <span className="field-error">{dateProblem}</span>
          ) : (
            <span className="field-hint">
              Cuándo se cobró o se acordó. Si ya la pagó, la fecha de ese pago.
            </span>
          )}
        </div>

        <div className="form-field">
          <label htmlFor="mora-amount">
            Monto <span className="required-mark">*</span>
          </label>
          <MoneyInput id="mora-amount" value={amountText} onChange={setAmountText} placeholder="Ej. 500" />
        </div>

        {/* Only when there is some: a bare «L. 0» read as an amount about to be charged. */}
        {automatic > 0 && (
          <p className="form-warning full-width">
            {itemName(installment)} ya tiene {formatMoney(cents(automatic), money)} de mora
            automática. Lo que cargues aquí se suma a esa.
          </p>
        )}

        <div className="form-field full-width">
          <label htmlFor="mora-reason">
            Motivo <span className="required-mark">*</span>
          </label>
          <textarea
            id="mora-reason"
            rows={2}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Ej. El 20 sep pagó L. 25,500: la cuota 4 y L. 500 de mora en efectivo."
          />
          <span className="field-hint">Queda en el Historial.</span>
          {trimmedReason.length > 0 && trimmedReason.length < MINIMUM_REASON && (
            <span className="field-error">Escribe al menos {MINIMUM_REASON} caracteres.</span>
          )}
        </div>

        <p className="form-note full-width">
          Si un pago ya registrado incluyó esta mora, ese pago y su recibo la mostrarán desde
          ahora, y el saldo sube lo mismo: ese dinero pagó la mora en vez del lote.
        </p>

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
          {isSaving ? "Cargando…" : "Cargar mora"}
        </button>
      </div>
    </Dialog>
  );
}

interface RemoveMoraDialogProps {
  contract: Contract;
  entry: ManualMora;
  money: MoneyView;
  onClose: () => void;
  onRemoved: () => void;
}

/** «Quitar»: for a mora put on by mistake. Asks why, and files it. */
function RemoveMoraDialog({ contract, entry, money, onClose, onRemoved }: RemoveMoraDialogProps) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);
  const trimmed = reason.trim();

  const submit = async () => {
    setError(null);
    setSaving(true);

    try {
      await removeContractMora(contract.id, entry.id, trimmed);
      onRemoved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo quitar la mora.");
      setSaving(false);
    }
  };

  return (
    <Dialog ariaLabel={`Quitar mora, contrato ${contract.code}`} onClose={onClose}>
      <div className="modal-header">
        <div>
          <p className="modal-eyebrow danger-eyebrow">Quitar mora</p>
          <h2>
            {itemName(entry.installment)} · {formatMoney(cents(entry.amountCents), money)}
          </h2>
          <p className="modal-description">
            {contract.code} · {formatDate(entry.incurredOn)}
          </p>
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Cerrar">
          <IconClose />
        </button>
      </div>

      <div className="modal-form-grid">
        <p className="form-note full-width">
          {entry.pendingCents < entry.amountCents
            ? "Lo que ya se pagó de esta mora vuelve a contar para las cuotas."
            : "Deja de contar en el saldo."}{" "}
          Queda en el Historial.
        </p>

        <div className="form-field full-width">
          <label htmlFor="mora-remove-reason">
            Motivo <span className="required-mark">*</span>
          </label>
          <textarea
            id="mora-remove-reason"
            rows={2}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Ej. Se cargó en el contrato equivocado."
          />
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
          disabled={trimmed.length < MINIMUM_REASON || isSaving}
          onClick={() => void submit()}
        >
          {isSaving ? "Quitando…" : "Quitar mora"}
        </button>
      </div>
    </Dialog>
  );
}
