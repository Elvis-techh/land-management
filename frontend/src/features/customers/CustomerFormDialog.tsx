import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import { businessYear } from "../../lib/businessTime";
import {
  COUNTRY_CODES,
  DEFAULT_DIAL,
  describePhoneProblem,
  joinPhone,
  splitPhone,
} from "../../lib/phone";
import type { CustomerRecord } from "../../types";
import type { CustomerDraft } from "./api";

interface CustomerFormDialogProps {
  /** `null` creates a customer; a customer edits that one. */
  customer: CustomerRecord | null;
  /**
   * Everyone already on file, so an identity number that is taken can be caught
   * here rather than on the round trip. The server checks the same thing.
   */
  customers: CustomerRecord[];
  onCancel: () => void;
  /** Rejects when the server refuses; the message is shown in the dialog. */
  onSave: (draft: CustomerDraft) => Promise<void>;
}

/** Blank means "not recorded", which is a different thing from an empty string. */
const orNull = (value: string): string | null => (value.trim() === "" ? null : value.trim());

/**
 * Create or edit a customer. One dialog for both, like ProjectFormDialog: the
 * fields are identical and only the wording and the starting values differ.
 */
export function CustomerFormDialog({
  customer,
  customers,
  onCancel,
  onSave,
}: CustomerFormDialogProps) {
  const isEditing = customer !== null;

  const [fullName, setFullName] = useState(customer?.fullName ?? "");
  const [identification, setIdentification] = useState(customer?.identification ?? "");
  // The country code and the national number are edited as two fields rather
  // than one. Typed as one string, "+504" is eight keystrokes nobody wants on a
  // phone keypad and the commonest thing to leave out — and a number saved
  // without it cannot be dialled by WhatsApp later.
  const [dialCode, setDialCode] = useState(
    () => (customer ? splitPhone(customer.phone).dialCode : DEFAULT_DIAL),
  );
  const [national, setNational] = useState(
    () => (customer ? splitPhone(customer.phone).national : ""),
  );
  const [email, setEmail] = useState(customer?.email ?? "");
  const [address, setAddress] = useState(customer?.address ?? "");
  const [customerSince, setCustomerSince] = useState(
    String(customer?.customerSince ?? businessYear()),
  );
  const [notes, setNotes] = useState(customer?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  // What the number will actually be stored as, and what is wrong with it if
  // anything. The problem is only shown once the user has typed something —
  // "obligatorio" on an untouched field reads like a telling-off.
  const phoneProblem = describePhoneProblem(dialCode, national);
  const phoneIsUnusable = national.trim() !== "" && phoneProblem !== null;

  // One person, one identity number. Entering somebody twice splits their
  // contracts across two records and quietly breaks both balances, so this is
  // caught before saving as well as by the server.
  //
  // Only once a number has actually been typed. The identidad is optional, and
  // every customer who has not given one would otherwise match every other
  // customer who has not given one — turning the commonest legitimate case into
  // a duplicate warning.
  const typedIdentification = identification.trim();

  const duplicate =
    typedIdentification === ""
      ? undefined
      : customers.find(
          (other) =>
            other.id !== customer?.id &&
            other.identification?.trim().toLowerCase() === typedIdentification.toLowerCase(),
        );

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    const year = Number(customerSince);

    if (!fullName.trim()) {
      setError("El nombre del cliente es obligatorio.");
      return;
    }
    if (duplicate) {
      setError(`La identidad ${typedIdentification} ya está registrada a nombre de ${duplicate.fullName}.`);
      return;
    }
    if (phoneProblem) {
      setError(phoneProblem);
      return;
    }
    if (!Number.isInteger(year) || year < 1900 || year > 2200) {
      setError("El año en que se volvió cliente no parece correcto.");
      return;
    }

    setSaving(true);

    try {
      await onSave({
        fullName: fullName.trim(),
        // Blank travels as blank; the server stores it as NULL. See the note on
        // `identification` in backend/src/db/schema.ts for why not "".
        identification: typedIdentification,
        // Sent with its country code already attached. The server normalises it
        // again and its answer is the stored one, so there is only ever one
        // implementation that counts.
        phone: joinPhone(dialCode, national),
        email: orNull(email),
        address: orNull(address),
        customerSince: year,
        notes: orNull(notes),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo guardar el cliente.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      ariaLabel={isEditing ? `Editar ${customer.fullName}` : "Nuevo cliente"}
      onClose={onCancel}
    >
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow">{isEditing ? "Editar cliente" : "Nuevo cliente"}</p>
            <h2>{fullName.trim() || "Sin nombre"}</h2>
            <p className="modal-description">
              Los contratos y el saldo no se escriben aquí: se calculan a partir de los
              contratos y los pagos registrados.
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Cerrar">
            <IconClose />
          </button>
        </div>

        <div className="modal-form-grid">
          <div className="form-field full-width">
            <label htmlFor="customer-name">Nombre completo</label>
            <input
              id="customer-name"
              value={fullName}
              placeholder="Ej. María Fernández"
              onChange={(event) => setFullName(event.target.value)}
            />
          </div>

          <div className="form-field">
            <label htmlFor="customer-id">Identidad (opcional)</label>
            <input
              id="customer-id"
              value={identification}
              placeholder="0801-1990-11207"
              aria-invalid={duplicate !== undefined}
              onChange={(event) => setIdentification(event.target.value)}
            />
            {duplicate ? (
              <span className="field-error">Ya registrada a nombre de {duplicate.fullName}.</span>
            ) : (
              /* Said out loud, because a blank field with no hint reads as one
                 the user forgot rather than one they are allowed to leave. */
              <span className="field-hint">
                Déjala en blanco si el cliente no la ha dado. Una persona, un número.
              </span>
            )}
          </div>

          <div className="form-field">
            <label htmlFor="customer-phone">Teléfono</label>
            <div className="phone-input">
              <select
                className="phone-dial"
                value={dialCode}
                aria-label="Código de país"
                onChange={(event) => setDialCode(event.target.value)}
              >
                {COUNTRY_CODES.map((country) => (
                  <option key={country.dial} value={country.dial}>
                    {country.dial === "+" ? "+ Otro" : `${country.dial} ${country.label}`}
                  </option>
                ))}
              </select>
              <input
                id="customer-phone"
                inputMode="tel"
                autoComplete="tel-national"
                value={national}
                placeholder="9982-4471"
                aria-invalid={phoneIsUnusable}
                onChange={(event) => setNational(event.target.value)}
              />
            </div>
            {phoneIsUnusable ? (
              <span className="field-error">{phoneProblem}</span>
            ) : (
              <span className="field-hint">
                {dialCode === "+504"
                  ? "Honduras. Cámbialo si el cliente está en otro país."
                  : `Se guardará como ${joinPhone(dialCode, national)}.`}
              </span>
            )}
          </div>

          <div className="form-field">
            <label htmlFor="customer-email">Correo</label>
            <input
              id="customer-email"
              type="email"
              value={email}
              placeholder="Opcional"
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div className="form-field">
            <label htmlFor="customer-since">Cliente desde</label>
            <input
              id="customer-since"
              type="number"
              inputMode="numeric"
              min="1900"
              max="2200"
              value={customerSince}
              onChange={(event) => setCustomerSince(event.target.value)}
            />
          </div>

          <div className="form-field full-width">
            <label htmlFor="customer-address">Dirección</label>
            <input
              id="customer-address"
              value={address}
              placeholder="Opcional"
              onChange={(event) => setAddress(event.target.value)}
            />
          </div>

          <div className="form-field full-width">
            <label htmlFor="customer-notes">Notas</label>
            <textarea
              id="customer-notes"
              rows={3}
              value={notes}
              placeholder="Ej. Prefiere que le escriban por WhatsApp en las tardes."
              onChange={(event) => setNotes(event.target.value)}
            />
            <span className="field-hint">
              Lo que conviene recordar de esta persona: cómo paga, a quién llamar, qué se
              acordó de palabra.
            </span>
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
            disabled={isSaving || duplicate !== undefined}
          >
            <span>
              {isSaving ? "Guardando…" : isEditing ? "Guardar cambios" : "Crear cliente"}
            </span>
          </button>
        </div>
      </form>
    </Dialog>
  );
}
