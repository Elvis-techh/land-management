import { useEffect, useState } from "react";

import { MoneyInput } from "../../components/MoneyInput";
import { contactLine } from "../../lib/business";
import { cents, parseMoneyInput, toMoneyInput } from "../../lib/money";
import type { User } from "../../lib/permissions";
import { can } from "../../lib/permissions";
import type { AppSettings, BusinessSettings, MoraSettings } from "./api";
import { saveSettings } from "./api";

/**
 * Every field as the form holds it: text, the way it was typed.
 *
 * Numbers stay strings until Guardar so a half-typed "2." or an emptied field
 * is not turned into something else under the user's fingers.
 */
interface FormState {
  mora: {
    enabled: boolean;
    startsOn: string;
    calculation: MoraSettings["calculation"];
    percent: string;
    fixed: string;
    graceDays: string;
    cap: string;
    frequency: MoraSettings["frequency"];
    chargeDownPayment: boolean;
    paymentOrder: MoraSettings["paymentOrder"];
  };
  contracts: {
    reservationMonths: string;
    atRiskPayments: string;
  };
  business: BusinessSettings;
}

function formFrom(settings: AppSettings): FormState {
  const { mora, contracts } = settings;

  return {
    mora: {
      enabled: mora.enabled,
      startsOn: mora.startsOn ?? "",
      calculation: mora.calculation,
      percent: mora.percent === 0 ? "" : String(mora.percent),
      fixed: mora.fixedCents === 0 ? "" : toMoneyInput(cents(mora.fixedCents)),
      graceDays: String(mora.graceDays),
      cap: mora.capCents === null ? "" : toMoneyInput(cents(mora.capCents)),
      frequency: mora.frequency,
      chargeDownPayment: mora.chargeDownPayment,
      paymentOrder: mora.paymentOrder,
    },
    contracts: {
      reservationMonths: String(contracts.reservationMonths),
      atRiskPayments: String(contracts.atRiskPayments),
    },
    business: { ...settings.business },
  };
}

/** An empty or unreadable amount is zero; the server then says what is missing. */
function typedCentsOrZero(formatted: string): number {
  const value = parseMoneyInput(formatted);
  return Number.isNaN(value) ? 0 : Math.round(value * 100);
}

/** A whole number, or NaN so the server refuses it with a message. */
function wholeNumber(typed: string): number {
  return typed.trim() === "" ? Number.NaN : Number(typed);
}

function settingsFrom(form: FormState): AppSettings {
  const { mora, contracts } = form;
  const percent = Number(mora.percent);
  const cap = typedCentsOrZero(mora.cap);

  return {
    mora: {
      enabled: mora.enabled,
      startsOn: mora.startsOn === "" ? null : mora.startsOn,
      calculation: mora.calculation,
      percent: mora.percent.trim() === "" || Number.isNaN(percent) ? 0 : percent,
      fixedCents: typedCentsOrZero(mora.fixed),
      graceDays: wholeNumber(mora.graceDays),
      capCents: cap > 0 ? cap : null,
      frequency: mora.frequency,
      chargeDownPayment: mora.chargeDownPayment,
      paymentOrder: mora.paymentOrder,
    },
    contracts: {
      reservationMonths: wholeNumber(contracts.reservationMonths),
      atRiskPayments: wholeNumber(contracts.atRiskPayments),
    },
    business: {
      name: form.business.name.trim(),
      signatory: form.business.signatory.trim(),
      location: form.business.location.trim(),
      phone: form.business.phone.trim(),
      email: form.business.email.trim(),
    },
  };
}

interface SettingsPageProps {
  user: User;
  settings: AppSettings;
  /** Called with what the server stored, so every screen reading it follows. */
  onSaved: (settings: AppSettings) => void;
}

/**
 * Configuración: the mora rules, the contract defaults and the business
 * details, on one screen with one Guardar.
 *
 * Everyone signed in can open it and read it. Who can change what is decided
 * per section (see backend/src/lib/settings.ts): the mora only by the
 * supervisor, always; the rest by whoever holds «Cambiar la configuración».
 */
export function SettingsPage({ user, settings, onSaved }: SettingsPageProps) {
  const [form, setForm] = useState<FormState>(() => formFrom(settings));
  const [isDirty, setDirty] = useState(false);
  const [isSaving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const canEditMora = can(user, "mora:edit");
  const canEditRest = can(user, "settings:edit");

  // Somebody else saved while this screen was open: show their values, unless
  // this person is in the middle of their own changes.
  useEffect(() => {
    if (!isDirty) {
      setForm(formFrom(settings));
    }
  }, [settings, isDirty]);

  function edit<K extends keyof FormState>(section: K, patch: Partial<FormState[K]>) {
    setForm((current) => ({ ...current, [section]: { ...current[section], ...patch } }));
    setDirty(true);
    setSavedAt(null);
  }

  const handleSave = async () => {
    setError(null);
    setSaving(true);

    try {
      // A section this person cannot change goes back exactly as it came, so
      // the server never mistakes a disabled field's rounding for a change.
      const typed = settingsFrom(form);
      const stored = await saveSettings({
        mora: canEditMora ? typed.mora : settings.mora,
        contracts: canEditRest ? typed.contracts : settings.contracts,
        business: canEditRest ? typed.business : settings.business,
      });
      setDirty(false);
      setForm(formFrom(stored));
      setSavedAt(Date.now());
      onSaved(stored);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudieron guardar los cambios.");
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    setForm(formFrom(settings));
    setDirty(false);
    setError(null);
  };

  const { mora, contracts, business } = form;
  const moraLocked = !canEditMora;
  const restLocked = !canEditRest;

  return (
    <section className="panel active">
      <div className="card permissions-intro">
        <h3>Configuración del negocio</h3>
        <p>
          Las reglas que la aplicación aplica a todos los contratos y lo que se imprime en recibos
          y constancias. Los cambios valen desde que se guardan y quedan en el Historial con tu
          nombre.
        </p>
      </div>

      <div className="card permission-group settings-group">
        <header className="permission-group-head">
          <h3>Mora</h3>
          <p className="field-hint">
            Recargo por pagar tarde.{" "}
            {moraLocked
              ? "Solo el supervisor puede cambiarla o apagarla."
              : "Solo el supervisor la cambia; no se puede ceder al asociado."}
          </p>
        </header>

        <p className="settings-notice">
          Todavía no se cobra: aquí se dejan listas las reglas, y el cobro llega en la próxima
          actualización. Hasta entonces ningún saldo cambia.
        </p>

        <div className="modal-form-grid settings-grid">
          <div className="form-field">
            <label htmlFor="settings-mora-enabled">Cobrar mora</label>
            <select
              id="settings-mora-enabled"
              value={mora.enabled ? "yes" : "no"}
              disabled={moraLocked}
              onChange={(event) => edit("mora", { enabled: event.target.value === "yes" })}
            >
              <option value="no">No</option>
              <option value="yes">Sí</option>
            </select>
          </div>

          <div className="form-field">
            <label htmlFor="settings-mora-from">Desde</label>
            <input
              id="settings-mora-from"
              type="date"
              value={mora.startsOn}
              readOnly={moraLocked}
              onChange={(event) => edit("mora", { startsOn: event.target.value })}
            />
            <span className="field-hint">
              Solo cuotas que vencen desde esta fecha. Nada de antes se cobra, así que tiene que
              ser hoy o después.
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="settings-mora-calculation">Cómo se calcula</label>
            <select
              id="settings-mora-calculation"
              value={mora.calculation}
              disabled={moraLocked}
              onChange={(event) =>
                edit("mora", { calculation: event.target.value as MoraSettings["calculation"] })
              }
            >
              <option value="percent">% de lo que falta de la cuota</option>
              <option value="fixed">Monto fijo</option>
            </select>
          </div>

          {mora.calculation === "percent" ? (
            <div className="form-field">
              <label htmlFor="settings-mora-percent">Porcentaje</label>
              <div className="input-with-suffix">
                <input
                  id="settings-mora-percent"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  max="100"
                  step="0.01"
                  value={mora.percent}
                  readOnly={moraLocked}
                  onChange={(event) => edit("mora", { percent: event.target.value })}
                />
                <span className="unit-suffix">%</span>
              </div>
              <span className="field-hint">
                De lo que falta de la cuota: 2 % de una cuota de L. 25,000.00 con la mitad pagada
                es 2 % de L. 12,500.00.
              </span>
            </div>
          ) : (
            <div className="form-field">
              <label htmlFor="settings-mora-fixed">Monto fijo</label>
              <MoneyInput
                id="settings-mora-fixed"
                value={mora.fixed}
                readOnly={moraLocked}
                onChange={(fixed) => edit("mora", { fixed })}
              />
            </div>
          )}

          <div className="form-field">
            <label htmlFor="settings-mora-grace">Días de gracia</label>
            <div className="input-with-suffix">
              <input
                id="settings-mora-grace"
                type="number"
                inputMode="numeric"
                min="0"
                max="31"
                value={mora.graceDays}
                readOnly={moraLocked}
                onChange={(event) => edit("mora", { graceDays: event.target.value })}
              />
              <span className="unit-suffix">días</span>
            </div>
            <span className="field-hint">
              También decide cuándo un contrato pasa a «Atrasado». Esto ya vale hoy.
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="settings-mora-cap">Máximo por cuota</label>
            <MoneyInput
              id="settings-mora-cap"
              value={mora.cap}
              placeholder="Sin máximo"
              readOnly={moraLocked}
              onChange={(cap) => edit("mora", { cap })}
            />
            <span className="field-hint">
              Lo más que una cuota puede sumar de mora, aunque siga atrasada. Vacío: sin máximo.
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="settings-mora-frequency">Cuándo se cobra</label>
            <select
              id="settings-mora-frequency"
              value={mora.frequency}
              disabled={moraLocked}
              onChange={(event) =>
                edit("mora", { frequency: event.target.value as MoraSettings["frequency"] })
              }
            >
              <option value="once">Una vez por cuota atrasada</option>
              <option value="monthly">Cada mes que siga atrasada</option>
            </select>
            <span className="field-hint">
              Cada mes se calcula sobre lo que falte de la cuota en ese momento.
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="settings-mora-prima">¿La prima lleva mora?</label>
            <select
              id="settings-mora-prima"
              value={mora.chargeDownPayment ? "yes" : "no"}
              disabled={moraLocked}
              onChange={(event) =>
                edit("mora", { chargeDownPayment: event.target.value === "yes" })
              }
            >
              <option value="no">No</option>
              <option value="yes">Sí</option>
            </select>
          </div>

          <div className="form-field">
            <label htmlFor="settings-mora-order">Un pago cubre primero</label>
            <select
              id="settings-mora-order"
              value={mora.paymentOrder}
              disabled={moraLocked}
              onChange={(event) =>
                edit("mora", { paymentOrder: event.target.value as MoraSettings["paymentOrder"] })
              }
            >
              <option value="mora">La mora</option>
              <option value="cuota">La cuota</option>
            </select>
          </div>

          <p className="field-hint full-width">
            Una mora pendiente no cambia el estado del contrato: «Al día» y «Atrasado» siguen
            dependiendo solo de las cuotas.
          </p>
        </div>
      </div>

      <div className="card permission-group settings-group">
        <header className="permission-group-head">
          <h3>Contratos</h3>
          {restLocked && (
            <p className="field-hint">Tu usuario no tiene permiso para cambiar esta sección.</p>
          )}
        </header>

        <div className="modal-form-grid settings-grid">
          <div className="form-field">
            <label htmlFor="settings-reservation">Una reserva dura</label>
            <div className="input-with-suffix">
              <input
                id="settings-reservation"
                type="number"
                inputMode="numeric"
                min="1"
                max="12"
                value={contracts.reservationMonths}
                readOnly={restLocked}
                onChange={(event) => edit("contracts", { reservationMonths: event.target.value })}
              />
              <span className="unit-suffix">
                {contracts.reservationMonths === "1" ? "mes" : "meses"}
              </span>
            </div>
            <span className="field-hint">
              El vencimiento que sugiere «Nuevo contrato». Se puede cambiar en cada reserva.
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="settings-at-risk">«En riesgo» desde</label>
            <div className="input-with-suffix settings-wide-suffix">
              <input
                id="settings-at-risk"
                type="number"
                inputMode="numeric"
                min="1"
                max="12"
                value={contracts.atRiskPayments}
                readOnly={restLocked}
                onChange={(event) => edit("contracts", { atRiskPayments: event.target.value })}
              />
              <span className="unit-suffix">pagos atrasados</span>
            </div>
            <span className="field-hint">Con menos, el contrato dice «Atrasado».</span>
          </div>
        </div>
      </div>

      <div className="card permission-group settings-group">
        <header className="permission-group-head">
          <h3>Datos del negocio</h3>
          <p className="field-hint">
            Lo que sale en recibos y constancias, también en los que se vuelvan a abrir.
            {restLocked && " Tu usuario no tiene permiso para cambiar esta sección."}
          </p>
        </header>

        <div className="modal-form-grid settings-grid">
          {(
            [
              ["name", "Nombre", "text"],
              ["signatory", "Firma", "text"],
              ["location", "Ubicación", "text"],
              ["phone", "Teléfono", "tel"],
              ["email", "Correo", "email"],
            ] as const
          ).map(([field, label, type]) => (
            <div key={field} className={field === "email" ? "form-field full-width" : "form-field"}>
              <label htmlFor={`settings-business-${field}`}>{label}</label>
              <input
                id={`settings-business-${field}`}
                type={type}
                value={business[field]}
                readOnly={restLocked}
                onChange={(event) => edit("business", { [field]: event.target.value })}
              />
            </div>
          ))}

          <div className="form-field full-width">
            <span className="field-hint">Así sale al pie del recibo</span>
            <p className="settings-footer-preview">
              <strong>{business.signatory} · Firma Autorizada</strong>
              {contactLine(business)}
            </p>
          </div>
        </div>
      </div>

      <div className="permission-actions">
        {error && <p className="form-error">{error}</p>}
        {savedAt !== null && !isDirty && <p className="field-hint">Cambios guardados.</p>}
        {isDirty && (
          <button type="button" className="btn-secondary" onClick={handleDiscard}>
            Descartar
          </button>
        )}
        <button
          type="button"
          className="btn-primary"
          disabled={!isDirty || isSaving || (moraLocked && restLocked)}
          onClick={() => void handleSave()}
        >
          {isSaving ? "Guardando…" : "Guardar cambios"}
        </button>
      </div>
    </section>
  );
}
