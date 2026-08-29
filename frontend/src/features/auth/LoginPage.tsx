import type { FormEvent } from "react";
import { useState } from "react";

import { IconBrand } from "../../components/Icons";
import { ApiError } from "../../lib/api";
import type { User } from "../../lib/permissions";
import { authApi } from "./api";

interface LoginPageProps {
  onSignedIn: (user: User) => void;
}

export function LoginPage({ onSignedIn }: LoginPageProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      onSignedIn(await authApi.login(email, password));
    } catch (caught) {
      // The server deliberately gives the same message for an unknown email as
      // for a wrong password, so this screen must not guess at a better one.
      setError(
        caught instanceof ApiError ? caught.message : "No se pudo iniciar sesión.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-brand">
          <div className="brand-mark">
            <IconBrand />
          </div>
          <div>
            <div className="brand-name">Lindero</div>
            <div className="brand-sub">Gestión de lotes</div>
          </div>
        </div>

        <h1 className="login-title">Iniciar sesión</h1>

        <div className="form-field full-width">
          <label htmlFor="login-email">Correo</label>
          <input
            id="login-email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>

        <div className="form-field full-width">
          <label htmlFor="login-password">Contraseña</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>

        {error && <p className="form-error">{error}</p>}

        <button type="submit" className="btn-primary login-submit" disabled={isSubmitting}>
          <span>{isSubmitting ? "Entrando…" : "Entrar"}</span>
        </button>
      </form>
    </div>
  );
}
