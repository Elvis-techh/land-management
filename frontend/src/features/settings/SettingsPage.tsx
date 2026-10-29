import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { MoneyInput } from "../../components/MoneyInput";
import { contactLine } from "../../lib/business";
import { cents, parseMoneyInput, toMoneyInput } from "../../lib/money";
import type { User } from "../../lib/permissions";
import { can } from "../../lib/permissions";
import type { AppSettings, BusinessSettings, MoraSettings } from "./api";
import { saveSettings } from "./api";
import type { MoraForm } from "./moraSummary";
import { moraSummary } from "./moraSummary";

/**
 * Every field as the form holds it: text, the way it was typed.
 *
 * Numbers stay strings until Guardar so a half-typed "2." or an emptied field
 * is not turned into something else under the user's fingers.
 */
interface FormState {
  mora: MoraForm;
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
      minimum: mora.minUnpaidCents === null ? "" : toMoneyInput(cents(mora.minUnpaidCents)),
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
  const minimum = typedCentsOrZero(mora.minimum);

  return {
    mora: {
      enabled: mora.enabled,
      startsOn: mora.startsOn === "" ? null : mora.startsOn,
      calculation: mora.calculation,
      percent: mora.percent.trim() === "" || Number.isNaN(percent) ? 0 : percent,
      fixedCents: typedCentsOrZero(mora.fixed),
      graceDays: wholeNumber(mora.graceDays),
      capCents: cap > 0 ? cap : null,
      minUnpaidCents: minimum > 0 ? minimum : null,
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

/**
 * A yes/no answer. A real switch for screen readers (`role="switch"`), and a
 * real button, so a locked one is `disabled` rather than merely grey.
 */
function Switch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="cfg-switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="cfg-switch-knob" />
    </button>
  );
}

interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/**
 * One answer out of a few. Radio buttons underneath, so the arrow keys, a
 * screen reader and a locked section all behave as they would on any form;
 * the tile or the pill is only how they look.
 */
function Choices<T extends string>({
  name,
  value,
  options,
  disabled,
  look,
  onChange,
}: {
  name: string;
  value: T;
  options: Array<Choice<T>>;
  disabled: boolean;
  look: "tiles" | "pill";
  onChange: (value: T) => void;
}) {
  return (
    <div className={look === "tiles" ? "cfg-tiles" : "cfg-pill"}>
      {options.map((option) => (
        <label key={option.value} className={look === "tiles" ? "cfg-tile" : "cfg-pill-option"}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={disabled}
            onChange={() => onChange(option.value)}
          />
          <b>{option.label}</b>
          {option.hint !== undefined && <small>{option.hint}</small>}
        </label>
      ))}
    </div>
  );
}

/**
 * A small whole number: − and + for a thumb, and the number itself is still
 * a field for whoever would rather type it.
 */
function Stepper({
  id,
  value,
  unit,
  min,
  max,
  less,
  more,
  readOnly,
  onChange,
}: {
  id: string;
  value: string;
  /** The unit after the number, already agreeing with it: "día" or "días". */
  unit: string;
  min: number;
  max: number;
  /** What the − and + buttons say to a screen reader, e.g. "Un día menos". */
  less: string;
  more: string;
  readOnly: boolean;
  onChange: (value: string) => void;
}) {
  const typed = Number(value);
  const current = value.trim() === "" || Number.isNaN(typed) ? min : typed;
  const stepTo = (next: number) => onChange(String(Math.min(max, Math.max(min, next))));

  return (
    <div className="cfg-stepper">
      <button
        type="button"
        aria-label={less}
        disabled={readOnly || current <= min}
        onClick={() => stepTo(current - 1)}
      >
        −
      </button>
      <span className="cfg-stepper-value">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={value}
          readOnly={readOnly}
          onChange={(event) => onChange(event.target.value)}
        />
        {unit}
      </span>
      <button
        type="button"
        aria-label={more}
        disabled={readOnly || current >= max}
        onClick={() => stepTo(current + 1)}
      >
        +
      </button>
    </div>
  );
}

/** A setting on one line: its name on the left, its control on the right. */
function SettingRow({
  htmlFor,
  name,
  hint,
  children,
}: {
  /** The control's id, when it has a field the name can label. */
  htmlFor?: string;
  name: string;
  hint?: string;
  children: ReactNode;
}) {
  const content = (
    <>
      {name}
      {hint !== undefined && <span className="cfg-row-hint">{hint}</span>}
    </>
  );

  return (
    <div className="cfg-row">
      {htmlFor === undefined ? (
        <span className="cfg-row-name">{content}</span>
      ) : (
        <label className="cfg-row-name" htmlFor={htmlFor}>
          {content}
        </label>
      )}
      {children}
    </div>
  );
}

/** A card's title, with its icon, the line under it and, for Mora, its switch. */
function CardHead({
  icon,
  tone,
  title,
  kicker,
  children,
}: {
  icon: ReactNode;
  tone: "clay" | "green" | "sand";
  title: string;
  kicker: string;
  children?: ReactNode;
}) {
  return (
    <header className="cfg-card-head">
      <span className={`cfg-card-icon ${tone}`} aria-hidden="true">
        {icon}
      </span>
      <h3>
        {title}
        <span className="cfg-kicker">{kicker}</span>
      </h3>
      {children}
    </header>
  );
}

const plural = (typed: string, one: string, many: string) => (typed.trim() === "1" ? one : many);

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
 *
 * The first screen in the app's new look («Lindero renovado»): its colours and
 * faces are the `.cfg` block in styles.css, kept there until the rest of the
 * app moves over.
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
  const restLockedNote = "Tu usuario no tiene permiso para cambiar esta sección.";

  const status =
    error ??
    (isDirty
      ? "Cambios sin guardar"
      : savedAt !== null
        ? "Cambios guardados."
        : moraLocked && restLocked
          ? "Solo puedes ver esta configuración."
          : "Todo está guardado.");
  const statusTone = error !== null ? "error" : isDirty ? "dirty" : savedAt !== null ? "saved" : "";

  return (
    <section className="panel active cfg">
      <header className="cfg-intro">
        <h2>Las reglas de tu negocio</h2>
        <p>
          Mora, contratos y lo que sale en los recibos, en un solo lugar. Los cambios valen desde
          que se guardan y quedan en el Historial con tu nombre.
        </p>
      </header>

      <div className="cfg-layout">
        <section className="cfg-card" aria-label="Mora">
          <CardHead
            tone="clay"
            title="Mora"
            kicker="Recargo por pagar tarde"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="13" r="8" />
                <path d="M12 9v4l2.5 2M9 2h6" />
              </svg>
            }
          >
            <Switch
              label="Cobrar mora"
              checked={mora.enabled}
              disabled={moraLocked}
              onChange={(enabled) => edit("mora", { enabled })}
            />
          </CardHead>

          <p className={mora.enabled ? "cfg-summary on" : "cfg-summary"} aria-live="polite">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v5M12 16h.01" />
            </svg>
            <span>{moraSummary(mora)}</span>
          </p>

          {/* Switched off, the rules fold away; what was typed in them is kept
              and comes back when it is switched on again. */}
          {mora.enabled && (
            <>
              <fieldset className="cfg-question">
                <legend>¿Cómo se calcula?</legend>
                <Choices
                  name="settings-mora-calculation"
                  look="tiles"
                  value={mora.calculation}
                  disabled={moraLocked}
                  onChange={(calculation) => edit("mora", { calculation })}
                  options={[
                    { value: "percent", label: "Porcentaje", hint: "De lo que falta de la cuota" },
                    { value: "fixed", label: "Monto fijo", hint: "Lo mismo en cada cuota" },
                  ]}
                />
              </fieldset>

              <div className="cfg-fields cfg-fields-three">
                {mora.calculation === "percent" ? (
                  <div className="cfg-field">
                    <label htmlFor="settings-mora-percent">Porcentaje</label>
                    <div className="cfg-suffixed">
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
                      <span aria-hidden="true">%</span>
                    </div>
                  </div>
                ) : (
                  <div className="cfg-field">
                    <label htmlFor="settings-mora-fixed">Monto fijo</label>
                    <MoneyInput
                      id="settings-mora-fixed"
                      value={mora.fixed}
                      readOnly={moraLocked}
                      onChange={(fixed) => edit("mora", { fixed })}
                    />
                  </div>
                )}

                <div className="cfg-field">
                  <label htmlFor="settings-mora-cap">Máximo por cuota</label>
                  <MoneyInput
                    id="settings-mora-cap"
                    value={mora.cap}
                    placeholder="Sin máximo"
                    readOnly={moraLocked}
                    onChange={(cap) => edit("mora", { cap })}
                  />
                </div>

                <div className="cfg-field cfg-wide-narrow">
                  <label htmlFor="settings-mora-from">Desde</label>
                  <input
                    id="settings-mora-from"
                    type="date"
                    value={mora.startsOn}
                    readOnly={moraLocked}
                    onChange={(event) => edit("mora", { startsOn: event.target.value })}
                  />
                  <span className="cfg-hint">Hoy o después, o volver a una fecha que ya estaba vigente.</span>
                </div>
              </div>

              <fieldset className="cfg-question">
                <legend>¿Cuándo se cobra?</legend>
                <Choices
                  name="settings-mora-frequency"
                  look="tiles"
                  value={mora.frequency}
                  disabled={moraLocked}
                  onChange={(frequency) => edit("mora", { frequency })}
                  options={[
                    { value: "once", label: "Una vez", hint: "Por cada cuota atrasada" },
                    { value: "monthly", label: "Cada mes", hint: "Sobre lo que falte ese mes" },
                  ]}
                />
              </fieldset>

              <div className="cfg-rows">
                <SettingRow name="La prima lleva mora">
                  <Switch
                    label="La prima lleva mora"
                    checked={mora.chargeDownPayment}
                    disabled={moraLocked}
                    onChange={(chargeDownPayment) => edit("mora", { chargeDownPayment })}
                  />
                </SettingRow>
                <SettingRow
                  htmlFor="settings-mora-minimum"
                  name="Sin mora si falta menos de"
                  hint="Para que unos centavos no cuesten una mora entera."
                >
                  <div className="cfg-field cfg-row-amount">
                    <MoneyInput
                      id="settings-mora-minimum"
                      value={mora.minimum}
                      placeholder="Sin mínimo"
                      readOnly={moraLocked}
                      onChange={(minimum) => edit("mora", { minimum })}
                    />
                  </div>
                </SettingRow>
                <SettingRow name="Un pago cubre primero">
                  <div role="radiogroup" aria-label="Un pago cubre primero">
                    <Choices<MoraSettings["paymentOrder"]>
                      name="settings-mora-order"
                      look="pill"
                      value={mora.paymentOrder}
                      disabled={moraLocked}
                      onChange={(paymentOrder) => edit("mora", { paymentOrder })}
                      options={[
                        { value: "mora", label: "La mora" },
                        { value: "cuota", label: "La cuota" },
                      ]}
                    />
                  </div>
                </SettingRow>
              </div>
            </>
          )}

          <div className="cfg-rows cfg-rows-ruled">
            <SettingRow
              htmlFor="settings-mora-grace"
              name="Días de gracia"
              hint="También decide «Atrasado». Ya vale hoy."
            >
              <Stepper
                id="settings-mora-grace"
                value={mora.graceDays}
                unit={plural(mora.graceDays, "día", "días")}
                min={0}
                max={31}
                less="Un día menos"
                more="Un día más"
                readOnly={moraLocked}
                onChange={(graceDays) => edit("mora", { graceDays })}
              />
            </SettingRow>
          </div>

          <p className="cfg-foot">
            Un cambio a la mora vale desde mañana: la mora ya cobrada, incluida la de hoy, no
            cambia. Una mora pendiente nunca pone un contrato «Atrasado».{" "}
            {moraLocked
              ? "Solo el supervisor puede cambiarla o apagarla."
              : "Solo el supervisor la cambia; no se puede ceder al asociado."}
          </p>
        </section>

        <div className="cfg-side">
          <section className="cfg-card" aria-label="Contratos">
            <CardHead
              tone="green"
              title="Contratos"
              kicker={restLocked ? restLockedNote : "Reservas y alertas"}
              icon={
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 3h7l5 5v13H7z" />
                  <path d="M14 3v5h5M10 13h6M10 17h6" />
                </svg>
              }
            />
            <div className="cfg-rows">
              <SettingRow
                htmlFor="settings-reservation"
                name="Una reserva dura"
                hint="Lo que sugiere «Nuevo contrato»"
              >
                <Stepper
                  id="settings-reservation"
                  value={contracts.reservationMonths}
                  unit={plural(contracts.reservationMonths, "mes", "meses")}
                  min={1}
                  max={12}
                  less="Un mes menos"
                  more="Un mes más"
                  readOnly={restLocked}
                  onChange={(reservationMonths) => edit("contracts", { reservationMonths })}
                />
              </SettingRow>
              <SettingRow
                htmlFor="settings-at-risk"
                name="«En riesgo» desde"
                hint="Con menos, dice «Atrasado»"
              >
                <Stepper
                  id="settings-at-risk"
                  value={contracts.atRiskPayments}
                  unit={plural(contracts.atRiskPayments, "pago", "pagos")}
                  min={1}
                  max={12}
                  less="Un pago menos"
                  more="Un pago más"
                  readOnly={restLocked}
                  onChange={(atRiskPayments) => edit("contracts", { atRiskPayments })}
                />
              </SettingRow>
            </div>
          </section>

          <section className="cfg-card" aria-label="Datos del negocio">
            <CardHead
              tone="sand"
              title="Datos del negocio"
              kicker={restLocked ? restLockedNote : "En recibos y constancias"}
              icon={
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 21V8l8-5 8 5v13" />
                  <path d="M9 21v-6h6v6" />
                </svg>
              }
            />
            <div className="cfg-fields">
              {(
                [
                  ["name", "Nombre", "text", "cfg-wide"],
                  ["signatory", "Firma", "text", ""],
                  ["location", "Ubicación", "text", ""],
                  ["phone", "Teléfono", "tel", "cfg-wide-narrow"],
                  ["email", "Correo", "email", "cfg-wide-narrow"],
                ] as const
              ).map(([field, label, type, width]) => (
                <div key={field} className={`cfg-field ${width}`}>
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
            </div>

            <p className="settings-footer-preview">
              <span>Pie del recibo</span>
              <strong>{business.signatory} · Firma Autorizada</strong>
              {contactLine(business)}
            </p>
          </section>
        </div>
      </div>

      <div className="cfg-savebar">
        <p className={`cfg-status ${statusTone}`} role={error !== null ? "alert" : undefined}>
          {status}
        </p>
        {isDirty && (
          <button type="button" className="cfg-btn-secondary" onClick={handleDiscard}>
            Descartar
          </button>
        )}
        <button
          type="button"
          className="cfg-btn-primary"
          disabled={!isDirty || isSaving || (moraLocked && restLocked)}
          onClick={() => void handleSave()}
        >
          {isSaving ? (
            "Guardando…"
          ) : (
            <>
              Guardar<span className="cfg-btn-more"> cambios</span>
            </>
          )}
        </button>
      </div>
    </section>
  );
}
