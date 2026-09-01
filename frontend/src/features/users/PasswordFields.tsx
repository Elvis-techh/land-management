/**
 * The password half of a form, shared by "new account" and "change password".
 *
 * Written once rather than twice because the rule and the wording have to
 * agree in both places: a minimum that says 10 in one dialog and enforces 8 in
 * the other is the kind of difference nobody notices until somebody is stuck at
 * a login screen.
 */

/** Kept in step with MINIMUM_PASSWORD_LENGTH in backend/src/routes/users.ts. */
export const MINIMUM_PASSWORD_LENGTH = 10;

/**
 * What is wrong with the pair, or `null` when they are usable.
 *
 * The confirmation field is not bureaucracy here. Nobody can read a password
 * back out of this system — it is stored as a hash — so a typo at this moment
 * is not a correctable mistake, it is an account that nobody can sign into and
 * nobody can explain.
 */
export function describePasswordProblem(password: string, confirmation: string): string | null {
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    return `La contraseña debe tener al menos ${MINIMUM_PASSWORD_LENGTH} caracteres.`;
  }
  if (password !== confirmation) {
    return "Las dos contraseñas no coinciden.";
  }

  return null;
}

interface PasswordFieldsProps {
  /** Prefix for the field ids, so two of these can never collide on a page. */
  idPrefix: string;
  password: string;
  confirmation: string;
  onPasswordChange: (value: string) => void;
  onConfirmationChange: (value: string) => void;
  hint: string;
}

export function PasswordFields({
  idPrefix,
  password,
  confirmation,
  onPasswordChange,
  onConfirmationChange,
  hint,
}: PasswordFieldsProps) {
  const tooShort = password !== "" && password.length < MINIMUM_PASSWORD_LENGTH;
  const mismatched = confirmation !== "" && password !== confirmation;

  return (
    <>
      <div className="form-field">
        <label htmlFor={`${idPrefix}-password`}>Contraseña</label>
        <input
          id={`${idPrefix}-password`}
          type="password"
          value={password}
          // Off on purpose: this is somebody ELSE's password being typed on the
          // supervisor's machine, and the browser must not offer to remember it
          // or fill it in from the supervisor's own saved credentials.
          autoComplete="new-password"
          aria-invalid={tooShort}
          onChange={(event) => onPasswordChange(event.target.value)}
        />
        {tooShort ? (
          <span className="field-error">
            Faltan {MINIMUM_PASSWORD_LENGTH - password.length} caracteres.
          </span>
        ) : (
          <span className="field-hint">{hint}</span>
        )}
      </div>

      <div className="form-field">
        <label htmlFor={`${idPrefix}-confirmation`}>Repetir contraseña</label>
        <input
          id={`${idPrefix}-confirmation`}
          type="password"
          value={confirmation}
          autoComplete="new-password"
          aria-invalid={mismatched}
          onChange={(event) => onConfirmationChange(event.target.value)}
        />
        {mismatched ? (
          <span className="field-error">No coincide con la de arriba.</span>
        ) : (
          <span className="field-hint">
            Nadie puede leerla después, ni siquiera tú. Un error de tecleo aquí deja la cuenta
            sin forma de entrar.
          </span>
        )}
      </div>
    </>
  );
}
