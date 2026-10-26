import { useCallback, useEffect, useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import { MoneyInput } from "../../components/MoneyInput";
import { businessToday } from "../../lib/businessTime";
import type { MoneyView } from "../../lib/money";
import { cents, formatMoney, toMoneyInput, typedCents } from "../../lib/money";
import type { User } from "../../lib/permissions";
import { can } from "../../lib/permissions";
import type { Contract } from "../../types";
import type { MoraSettings } from "../settings/api";
import type {
  ContractMora as ContractMoraData,
  ContractMoraRule,
  ContractMoraRuleVersion,
  ManualMora,
  OwnMoraRules,
} from "./api";
import { chargeContractMora, fetchContractMora, removeContractMora, setContractMoraRule } from "./api";
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

/** The rule in force on `date`, from versions oldest first. */
function ruleOn(versions: readonly ContractMoraRuleVersion[], date: string): ContractMoraRuleVersion | null {
  let found: ContractMoraRuleVersion | null = null;

  for (const version of versions) {
    if (version.effectiveFrom > date) {
      break;
    }

    found = version;
  }

  return found;
}

/** How much and how often, as Configuración says it: "10 % de lo que falta de la cuota (hasta L. 500)…". */
function amountSentence(rules: OwnMoraRules, money: MoneyView): string {
  const amount =
    rules.calculation === "percent"
      ? `${rules.percent} % de lo que falta de la cuota`
      : `${formatMoney(cents(rules.fixedCents), money)} fijos`;
  const cap = rules.capCents === null ? "" : ` (hasta ${formatMoney(cents(rules.capCents), money)} por cuota)`;
  const when = rules.frequency === "once" ? "una vez por cuota atrasada" : "cada mes que siga atrasada";
  const minimum =
    rules.minUnpaidCents === null
      ? ""
      : `. No se cobra si de la cuota falta menos de ${formatMoney(cents(rules.minUnpaidCents), money)}`;

  return `${amount}${cap}, ${when}${minimum}.`;
}

/** One rule, read out in a sentence, beside the general one it is laid over. */
function ruleSentence(rule: ContractMoraRule, general: MoraSettings, money: MoneyView): string {
  if (rule.mode === "none") {
    return "Sin mora: este contrato no lleva mora.";
  }

  if (!general.enabled) {
    // The switch is the general rule's: off, nobody is charged.
    return rule.mode === "own"
      ? `Regla propia: ${amountSentence(rule.rules, money)} No se cobra mientras la mora esté apagada en Configuración.`
      : "La general, y la mora está apagada en Configuración.";
  }

  return rule.mode === "own"
    ? `Regla propia: ${amountSentence(rule.rules, money)}`
    : `La general: ${amountSentence(general, money)}`;
}

/**
 * «Cargar mora»: mora put on this contract by hand, and the list of what was.
 *
 * For what the automatic mora never does, because it never charges backwards:
 * mora the customer paid before mora was switched on, and mora agreed for a
 * cuota that was late before «Desde». See GET /contracts/:id/mora.
 *
 * Above it, «Regla de mora»: the rule this contract's mora follows, the
 * general one or its own, and «Cambiar» for a supervisor. See
 * `moraContractRules` in the backend.
 *
 * Fetched when the panel opens, like the documents: the contracts list only
 * needs the totals, which already include these.
 */
export function ContractMora({ contract, money, user, onChanged }: ContractMoraProps) {
  const [data, setData] = useState<ContractMoraData | null>(null);
  const [isCharging, setCharging] = useState(false);
  const [removing, setRemoving] = useState<ManualMora | null>(null);
  const [isChangingRule, setChangingRule] = useState(false);
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

  if (data === null || (!data.chargeable && data.manual.length === 0 && data.rules.length === 0)) {
    return null;
  }

  const afterChange = () => {
    load();
    onChanged();
  };

  const today = businessToday();
  const current = ruleOn(data.rules, today);
  const upcoming = data.rules.find((version) => version.effectiveFrom > today) ?? null;

  return (
    <>
      <section className="cp-section">
        <div className="cp-docs-head">
          <h3 className="cp-section-title">Regla de mora</h3>
          {canCharge && data.chargeable && (
            <button type="button" className="btn-secondary is-small" onClick={() => setChangingRule(true)}>
              Cambiar
            </button>
          )}
        </div>
        <p className="cp-mora-rule">
          {ruleSentence(current?.rule ?? { mode: "general" }, data.general, money)}
          {current && current.rule.mode !== "general" && (
            <span className="cp-doc-sub is-prose">
              {current.reason} · {current.recordedBy}
            </span>
          )}
        </p>
        {upcoming && (
          <p className="cp-mora-rule is-upcoming">
            <strong>Desde mañana:</strong> {ruleSentence(upcoming.rule, data.general, money)}
            <span className="cp-doc-sub is-prose">
              {upcoming.reason} · {upcoming.recordedBy}
            </span>
          </p>
        )}

        {isChangingRule && (
          <ContractRuleDialog
            contract={contract}
            data={data}
            rule={(upcoming ?? current)?.rule ?? { mode: "general" }}
            money={money}
            onClose={() => setChangingRule(false)}
            onSaved={() => {
              setChangingRule(false);
              afterChange();
            }}
          />
        )}
      </section>

      {(data.chargeable || data.manual.length > 0) && (
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
      )}
    </>
  );
}

interface ContractRuleDialogProps {
  contract: Contract;
  data: ContractMoraData;
  /** The rule it will have tomorrow as things stand: what the form starts from. */
  rule: ContractMoraRule;
  money: MoneyView;
  onClose: () => void;
  onSaved: () => void;
}

/** A blank money box for "none", like Configuración's «Sin máximo». */
const moneyText = (value: number | null) => (value === null ? "" : toMoneyInput(cents(value)));

/** «Cambiar» under «Regla de mora»: General, «Sin mora» or «Regla propia», with a reason. */
function ContractRuleDialog({ contract, data, rule, money, onClose, onSaved }: ContractRuleDialogProps) {
  // A «Regla propia» starts from its own numbers, or from the general ones.
  const start: OwnMoraRules = rule.mode === "own" ? rule.rules : data.general;
  const [mode, setMode] = useState<ContractMoraRule["mode"]>(rule.mode);
  const [calculation, setCalculation] = useState(start.calculation);
  const [percent, setPercent] = useState(start.percent === 0 ? "" : String(start.percent));
  const [fixed, setFixed] = useState(start.fixedCents === 0 ? "" : moneyText(start.fixedCents));
  const [cap, setCap] = useState(moneyText(start.capCents));
  const [minimum, setMinimum] = useState(moneyText(start.minUnpaidCents));
  const [frequency, setFrequency] = useState(start.frequency);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  const tomorrow = dayAfter(businessToday());
  const percentValue = Number(percent);
  const own: OwnMoraRules = {
    calculation,
    percent: percent.trim() === "" || Number.isNaN(percentValue) ? 0 : percentValue,
    fixedCents: typedCents(fixed),
    capCents: typedCents(cap) || null,
    minUnpaidCents: typedCents(minimum) || null,
    frequency,
  };
  const next: ContractMoraRule = mode === "own" ? { mode, rules: own } : { mode };
  const trimmedReason = reason.trim();
  const amountMissing =
    mode === "own" &&
    ((calculation === "percent" && (own.percent <= 0 || own.percent > 100)) ||
      (calculation === "fixed" && own.fixedCents <= 0));
  const canSubmit = !amountMissing && trimmedReason.length >= MINIMUM_REASON && !isSaving;

  const submit = async () => {
    setError(null);
    setSaving(true);

    try {
      await setContractMoraRule(contract.id, { ...next, reason: trimmedReason });
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo cambiar la regla.");
      setSaving(false);
    }
  };

  return (
    <Dialog ariaLabel={`Regla de mora, contrato ${contract.code}`} onClose={onClose}>
      <div className="modal-header">
        <div>
          <p className="modal-eyebrow">Regla de mora</p>
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
        <div className="form-field full-width">
          <label htmlFor="mora-rule-mode">
            Regla <span className="required-mark">*</span>
          </label>
          <select
            id="mora-rule-mode"
            value={mode}
            onChange={(event) => setMode(event.target.value as ContractMoraRule["mode"])}
          >
            <option value="general">La general de Configuración</option>
            <option value="none">Sin mora</option>
            <option value="own">Regla propia</option>
          </select>
          <span className="field-hint">{ruleSentence(next, data.general, money)}</span>
        </div>

        {mode === "own" && (
          <>
            <div className="form-field">
              <label htmlFor="mora-rule-calculation">Cómo se calcula</label>
              <select
                id="mora-rule-calculation"
                value={calculation}
                onChange={(event) => setCalculation(event.target.value as OwnMoraRules["calculation"])}
              >
                <option value="percent">Porcentaje de lo que falta</option>
                <option value="fixed">Monto fijo</option>
              </select>
            </div>

            {calculation === "percent" ? (
              <div className="form-field">
                <label htmlFor="mora-rule-percent">
                  Porcentaje <span className="required-mark">*</span>
                </label>
                <input
                  id="mora-rule-percent"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  max="100"
                  step="0.01"
                  value={percent}
                  placeholder="Ej. 2"
                  onChange={(event) => setPercent(event.target.value)}
                />
              </div>
            ) : (
              <div className="form-field">
                <label htmlFor="mora-rule-fixed">
                  Monto fijo <span className="required-mark">*</span>
                </label>
                <MoneyInput id="mora-rule-fixed" value={fixed} onChange={setFixed} placeholder="Ej. 500" />
              </div>
            )}

            <div className="form-field">
              <label htmlFor="mora-rule-cap">Máximo por cuota</label>
              <MoneyInput id="mora-rule-cap" value={cap} onChange={setCap} placeholder="Sin máximo" />
            </div>

            <div className="form-field">
              <label htmlFor="mora-rule-minimum">Sin mora si falta menos de</label>
              <MoneyInput id="mora-rule-minimum" value={minimum} onChange={setMinimum} placeholder="Sin mínimo" />
            </div>

            <div className="form-field full-width">
              <label htmlFor="mora-rule-frequency">Cuándo se cobra</label>
              <select
                id="mora-rule-frequency"
                value={frequency}
                onChange={(event) => setFrequency(event.target.value as OwnMoraRules["frequency"])}
              >
                <option value="once">Una vez por cuota atrasada</option>
                <option value="monthly">Cada mes que siga atrasada</option>
              </select>
            </div>
          </>
        )}

        <div className="form-field full-width">
          <label htmlFor="mora-rule-reason">
            Motivo <span className="required-mark">*</span>
          </label>
          <textarea
            id="mora-rule-reason"
            rows={2}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Ej. El contrato firmado dice L. 300 fijos por cuota atrasada."
          />
          <span className="field-hint">Queda en el Historial.</span>
          {trimmedReason.length > 0 && trimmedReason.length < MINIMUM_REASON && (
            <span className="field-error">Escribe al menos {MINIMUM_REASON} caracteres.</span>
          )}
        </div>

        <p className="form-note full-width">
          Cuenta desde mañana, {formatDate(tomorrow)}. La mora ya cobrada no cambia. Los días de
          gracia, «Desde» y lo que un pago cubre primero siguen siendo los de Configuración.
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
          {isSaving ? "Guardando…" : "Guardar regla"}
        </button>
      </div>
    </Dialog>
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
