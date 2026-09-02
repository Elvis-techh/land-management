import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import type { Role } from "../../lib/permissions";
import { ROLE_LABELS } from "../../lib/permissions";
import type { UserAccount, UserDraft } from "./api";
import { MINIMUM_PASSWORD_LENGTH, PasswordFields, describePasswordProblem } from "./PasswordFields";

interface UserFormDialogProps {
  /** `null` creates an account; an account edits that one. */
  account: UserAccount | null;
  /** Everyone already on file, so a taken email is caught before the round trip. */
  users: UserAccount[];
  /** Whether this dialog is editing the signed-in supervisor's own account. */
  isSelf: boolean;
  onCancel: () => void;
  /**
   * Rejects when the server refuses; the message is shown in the dialog.
   * `password` is present only when creating — an edit never touches it.
   */
  onSave: (draft: UserDraft & { password?: string }) => Promise<void>;
}

const ROLE_HINTS: Record<Role, string> = {
  owner:
    "Puede todo, incluyendo crear cuentas y editar permisos. Conviene tener al menos dos, " +
    "para que nadie se quede fuera si uno pierde su contraseña.",
  staff:
    "Hace el trabajo del día a día. Lo que puede hacer exactamente se decide en la pantalla " +
    "de Permisos y aplica a todos los asociados por igual.",
};

/**
 * Create or edit an account — one dialog for both, like CustomerFormDialog.
 *
 * The password appears only when creating. Changing it later is a separate,
 * deliberate action with its own dialog, because it signs the person out
 * everywhere and that should never be a side effect of fixing a typo in a name.
 */
export function UserFormDialog({
  account,
  users,
  isSelf,
  onCancel,
  onSave,
}: UserFormDialogProps) {
  const isEditing = account !== null;

  const [name, setName] = useState(account?.name ?? "");
  const [email, setEmail] = useState(account?.email ?? "");
  const [role, setRole] = useState<Role>(account?.role ?? "staff");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  // One address, one account — it is what somebody types to sign in, so a
  // duplicate is not a tidiness problem but two people who cannot both get in.
  const typedEmail = email.trim().toLowerCase();

  const duplicate =
    typedEmail === ""
      ? undefined
      : users.find((other) => other.id !== account?.id && other.email.toLowerCase() === typedEmail);

  const passwordProblem = isEditing
    ? null
    : describePasswordProblem(password, confirmation);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError("El nombre es obligatorio: es el que aparecerá en el historial.");
      return;
    }
    if (typedEmail === "" || !typedEmail.includes("@")) {
      setError("Escribe un correo válido. Es con lo que esta persona iniciará sesión.");
      return;
    }
    if (duplicate) {
      setError(`El correo ${typedEmail} ya lo usa la cuenta de ${duplicate.name}.`);
      return;
    }
    if (passwordProblem) {
      setError(passwordProblem);
      return;
    }

    setSaving(true);

    try {
      await onSave({
        name: name.trim(),
        email: typedEmail,
        role,
        ...(isEditing ? {} : { password }),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo guardar la cuenta.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      ariaLabel={isEditing ? `Editar la cuenta de ${account.name}` : "Nueva cuenta"}
      onClose={onCancel}
    >
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow">{isEditing ? "Editar cuenta" : "Nueva cuenta"}</p>
            <h2>{name.trim() || "Sin nombre"}</h2>
            <p className="modal-description">
              {isEditing
                ? "La contraseña no se edita aquí. Cambiarla es una acción aparte, porque " +
                  "cierra la sesión de esta persona en todos sus dispositivos."
                : "Entrega la contraseña en persona o por un medio que confíes. El sistema " +
                  "no la envía por correo ni la vuelve a mostrar después de crear la cuenta."}
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Cerrar">
            <IconClose />
          </button>
        </div>

        <div className="modal-form-grid">
          <div className="form-field">
            <label htmlFor="user-name">Nombre completo</label>
            <input
              id="user-name"
              value={name}
              placeholder="Ej. Ana Lucía Paz"
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
            />
            <span className="field-hint">
              Así aparecerá en el historial, junto a cada cosa que haga.
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="user-email">Correo</label>
            <input
              id="user-email"
              type="email"
              value={email}
              placeholder="ana@ejemplo.hn"
              autoComplete="off"
              aria-invalid={duplicate !== undefined}
              onChange={(event) => setEmail(event.target.value)}
            />
            {duplicate ? (
              <span className="field-error">Ya lo usa la cuenta de {duplicate.name}.</span>
            ) : (
              <span className="field-hint">Con esto inicia sesión. No se le envía nada.</span>
            )}
          </div>

          <div className="form-field full-width">
            <label htmlFor="user-role">Rol</label>
            <select
              id="user-role"
              value={role}
              // Nobody changes their own role: the server refuses it, because a
              // supervisor who demotes themselves loses the permission needed
              // to put it back — including on the very next request.
              disabled={isEditing && isSelf}
              onChange={(event) => setRole(event.target.value as Role)}
            >
              <option value="staff">{ROLE_LABELS.staff}</option>
              <option value="owner">{ROLE_LABELS.owner}</option>
            </select>
            <span className="field-hint">
              {isEditing && isSelf
                ? "No puedes cambiar tu propio rol. Pide a otro supervisor que lo haga, para " +
                  "que nadie se quede fuera de su propia aplicación."
                : ROLE_HINTS[role]}
            </span>
          </div>

          {!isEditing && (
            <PasswordFields
              idPrefix="user-new"
              password={password}
              confirmation={confirmation}
              onPasswordChange={setPassword}
              onConfirmationChange={setConfirmation}
              hint={
                `Al menos ${MINIMUM_PASSWORD_LENGTH} caracteres. Una frase corta que solo esta ` +
                "persona sepa es mejor que algo corto y complicado."
              }
            />
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
            disabled={isSaving || duplicate !== undefined}
          >
            <span>{isSaving ? "Guardando…" : isEditing ? "Guardar cambios" : "Crear cuenta"}</span>
          </button>
        </div>
      </form>
    </Dialog>
  );
}
