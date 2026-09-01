import { useState } from "react";

import { IconEdit, IconPermissions, IconRestore, IconArchive } from "../../components/Icons";
import { businessTimeZone, calendarDaysBetween } from "../../lib/businessTime";
import { getInitials } from "../../lib/initials";
import { ROLE_LABELS } from "../../lib/permissions";
import { parseTimestamp } from "../../lib/time";
import type { UserAccount } from "./api";

interface UsersPageProps {
  users: UserAccount[];
  onCreate: () => void;
  onEdit: (account: UserAccount) => void;
  onResetPassword: (account: UserAccount) => void;
  onDeactivate: (account: UserAccount) => void;
  onReactivate: (account: UserAccount) => Promise<void>;
}

/**
 * When somebody last signed in, said the way a person would say it.
 *
 * "Hace 3 días" answers the question a supervisor is actually asking — is this
 * account still in use — which an exact timestamp makes them work out for
 * themselves. Anything past a month is old enough that the date is the more
 * useful answer again.
 *
 * Never having signed in is handled by the caller, since it is not a date at
 * all: it is what a brand new account looks like, and how a supervisor spots
 * the hire who never got in because the password was mistyped when it was
 * handed over.
 */
function describeSignIn(value: string): string {
  const then = parseTimestamp(value);

  if (Number.isNaN(then)) {
    return value;
  }

  /*
   * CALENDAR days in the office, not elapsed twenty-four-hour blocks.
   *
   * `(Date.now() - then) / 86_400_000` is the obvious spelling and it answers a
   * different question: somebody who signed in at nine last night is fifteen
   * hours ago, so it says "Hoy" until nine tonight. A supervisor asking when an
   * account was last used means yesterday, and being told "today" about an
   * account nobody has touched since yesterday evening is exactly the wrong
   * answer for the thing this column is read for.
   */
  const days = calendarDaysBetween(new Date(then), new Date());

  if (days <= 0) {
    return "Hoy";
  }
  if (days === 1) {
    return "Ayer";
  }
  if (days < 30) {
    return `Hace ${days} días`;
  }

  // The office's clock, for the same reason as the Historial screen.
  return new Date(then).toLocaleDateString("es-HN", {
    timeZone: businessTimeZone(),
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/**
 * The accounts that can sign in: who exists, what role they hold, and whether
 * they still have a way in.
 *
 * This screen is about PEOPLE. What the associate role is allowed to do is the
 * Permisos screen's question, and the two are kept apart deliberately — hiring
 * is a weekly job, while deciding what an associate is trusted with is a rare
 * decision that deserves its own screen.
 */
export function UsersPage({
  users,
  onCreate,
  onEdit,
  onResetPassword,
  onDeactivate,
  onReactivate,
}: UsersPageProps) {
  // Deactivated accounts are kept off the working list by default, exactly like
  // archived projects — but one click away, since a rehire is a real thing.
  const [showDeactivated, setShowDeactivated] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const active = users.filter((account) => account.deactivatedAt === null);
  const deactivated = users.filter((account) => account.deactivatedAt !== null);
  const visible = showDeactivated ? deactivated : active;

  const handleReactivate = async (account: UserAccount) => {
    setError(null);
    setBusyId(account.id);

    try {
      await onReactivate(account);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : `No se pudo reactivar a ${account.name}.`,
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="panel active">
      <div className="card users-intro">
        <h3>Quién puede entrar</h3>
        <p>
          Cada persona que usa Lindero necesita su propia cuenta. Compartir una sola cuenta
          hace que el historial deje de servir: todo lo que hagan aparecerá con un mismo
          nombre, y la pregunta «¿quién registró este pago?» se queda sin respuesta.
        </p>
        <p className="field-hint">
          Lo que un asociado <strong>puede hacer</strong> no se decide aquí, sino en la
          pantalla de Permisos, y aplica a todas las cuentas de asociado por igual.
        </p>
      </div>

      <div className="toolbar">
        <button
          type="button"
          className={showDeactivated ? "chip" : "chip active"}
          onClick={() => setShowDeactivated(false)}
        >
          Activas ({active.length})
        </button>
        <button
          type="button"
          className={showDeactivated ? "chip active" : "chip"}
          onClick={() => setShowDeactivated(true)}
        >
          Desactivadas ({deactivated.length})
        </button>
      </div>

      {error && (
        <div className="card">
          <p className="form-error">{error}</p>
        </div>
      )}

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Persona</th>
                <th>Correo</th>
                <th>Rol</th>
                <th>Último acceso</th>
                <th className="col-actions">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((account) => {
                const isDeactivated = account.deactivatedAt !== null;
                const isBusy = busyId === account.id;

                return (
                  <tr key={account.id}>
                    <td>
                      <span className="holder-btn is-static">
                        <span className="holder-avatar">{getInitials(account.name)}</span>
                        <span className="holder-text">
                          <span className="holder-name">{account.name}</span>
                          <span className="holder-contract">
                            {account.isSelf ? "Tu cuenta" : ROLE_LABELS[account.role]}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td className="mono">{account.email}</td>
                    <td>
                      <span
                        className={
                          isDeactivated
                            ? "stamp neutral"
                            : account.role === "owner"
                              ? "stamp clay"
                              : "stamp success"
                        }
                      >
                        {isDeactivated ? "Desactivada" : ROLE_LABELS[account.role]}
                      </span>
                    </td>
                    <td>
                      {account.lastSignInAt === null ? (
                        // Not blank: an empty cell reads as data that failed to
                        // load rather than an account nobody has used yet.
                        <span className="holder-empty">Nunca ha entrado</span>
                      ) : (
                        describeSignIn(account.lastSignInAt)
                      )}
                    </td>
                    <td>
                      <span className="row-actions">
                        {isDeactivated ? (
                          <button
                            type="button"
                            className="row-action"
                            disabled={isBusy}
                            onClick={() => void handleReactivate(account)}
                            title={`Reactivar la cuenta de ${account.name}`}
                            aria-label={`Reactivar la cuenta de ${account.name}`}
                          >
                            <IconRestore />
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="row-action"
                              onClick={() => onEdit(account)}
                              title={`Editar la cuenta de ${account.name}`}
                              aria-label={`Editar la cuenta de ${account.name}`}
                            >
                              <IconEdit />
                            </button>
                            <button
                              type="button"
                              className="row-action"
                              onClick={() => onResetPassword(account)}
                              title={`Cambiar la contraseña de ${account.name}`}
                              aria-label={`Cambiar la contraseña de ${account.name}`}
                            >
                              <IconPermissions />
                            </button>
                            {/* Hidden on your own row rather than shown and
                                refused: the server says no, but a button that
                                locks you out of the app on the next click is
                                not one to offer in the first place. */}
                            {!account.isSelf && (
                              <button
                                type="button"
                                className="row-action danger"
                                onClick={() => onDeactivate(account)}
                                title={`Desactivar la cuenta de ${account.name}`}
                                aria-label={`Desactivar la cuenta de ${account.name}`}
                              >
                                <IconArchive />
                              </button>
                            )}
                          </>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}

              {visible.length === 0 && (
                <tr>
                  <td colSpan={5} className="table-empty">
                    {showDeactivated ? (
                      "No hay cuentas desactivadas."
                    ) : (
                      <>
                        <p>Todavía no hay ninguna cuenta activa además de la tuya.</p>
                        <button type="button" className="link-btn" onClick={onCreate}>
                          Crear la primera cuenta
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
