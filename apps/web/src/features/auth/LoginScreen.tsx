import { useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { login } from "@/features/auth/authSlice";
import Brand from "@/components/Brand";

export default function LoginScreen() {
  const dispatch = useAppDispatch();
  const status = useAppSelector((state) => state.auth.status);
  const error = useAppSelector((state) => state.auth.error);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const submitting = status === "authenticating";

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!username || !password) return;
    dispatch(login({ username, password }));
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-card__brand">
          <Brand size="lg" withCaption />
        </div>
        <div>
          <div className="login-card__title">Connexion</div>
          <p className="login-card__subtitle">Authentification via l'annuaire LDAP.</p>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <div className="field">
          <label htmlFor="username">Identifiant</label>
          <input
            id="username"
            name="username"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            disabled={submitting}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="password">Mot de passe</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={submitting}
            required
          />
        </div>

        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? "Connexion…" : "Se connecter"}
        </button>
      </form>
    </div>
  );
}
