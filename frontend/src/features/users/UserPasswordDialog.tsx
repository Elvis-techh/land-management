import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import type { UserAccount } from "./api";
import { MINIMUM_PASSWORD_LENGTH, PasswordFields, describePasswordProblem } from "./PasswordFields";

interface UserPasswordDialogProps {
  account: UserAccount;
  onCancel: () => void;
  /** Rejects when the server refuses; the message is shown in the dialog. */
  onConfirm: (password: string) => Promise<void>;
}

/**
 * Set somebody's password, which is the only thing a supervisor can do about a
 * forgotten one: there is nothing to recover, only a hash.
 *
 * The dialog says out loud that it ends the person's sessions, because that is
 * the surprising part. A supervisor resetting a password for a colleague who is
 * mid-shift should know they are about to interrupt them.
 */
export function UserPasswordDialog({ account, onCancel, onConfirm }: UserPasswordDialogProps) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    const problem = describePasswordProblem(password, confirmation);

    if (problem) {
      setError(problem);
      return;
    }

    setSaving(true);

    try {
      await onConfirm(password);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "No se pudo cambiar la contraseña.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog ariaLabel={`Cambiar la contraseña de ${account.name}`} onClose={onCancel}>
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow">Cambiar contraseña</p>
            <h2>{account.name}</h2>
            <p className="modal-description">
              {account.isSelf
                ? "Vas a cambiar la contraseña de tu propia cuenta. Se cerrará tu sesión en " +
                  "los demás dispositivos donde la tengas abierta."
                : `La contraseña anterior deja de funcionar de inmediato y ${account.name} ` +
                  "sale de la aplicación en todos sus dispositivos."}
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Cerrar">
            <IconClose />
          </button>
        </div>

        <div className="modal-form-grid">
          <p className="form-warning full-width">
            Nadie puede consultar la contraseña actual: el sistema solo guarda una huella de
            ella. Esto no la recupera, la reemplaza — anótala y entrégala en persona.
          </p>

          <PasswordFields
            idPrefix="user-reset"
            password={password}
            confirmation={confirmation}
            onPasswordChange={setPassword}
            onConfirmationChange={setConfirmation}
            hint={`Al menos ${MINIMUM_PASSWORD_LENGTH} caracteres.`}
          />

          {error && <p className="form-error full-width">{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={isSaving}>
            Cancelar
          </button>
          <button type="submit" className="btn-primary modal-submit" disabled={isSaving}>
            <span>{isSaving ? "Guardando…" : "Cambiar contraseña"}</span>
          </button>
        </div>
      </form>
    </Dialog>
  );
}
