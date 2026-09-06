/**
 * Sign in / sign up.
 *
 * Contract 1's 401 message is deliberately identical for an unknown email and
 * a wrong password. This page shows `body.error` verbatim and adds nothing of
 * its own — anything more specific would reintroduce the user enumeration the
 * contract removes.
 */

import { useState, type FormEvent, type ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";

type Mode = "login" | "signup";

export function AuthPage(): ReactNode {
  const { login, signup } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") await login(email, password);
      else await signup(email, password, displayName.trim() || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong on our end.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h1 className="wordmark">
          TaskFlow<span className="dot">.</span>
        </h1>
        <p className="auth-tagline">
          A board that moves when your team does — every change, on every screen, in under a
          second.
        </p>

        <form onSubmit={(e) => void submit(e)}>
          {mode === "signup" && (
            <div className="field">
              <label htmlFor="display_name">Display name (optional)</label>
              <input
                id="display_name"
                className="input"
                autoComplete="nickname"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
          )}

          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              required
              className="input"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              required
              className="input"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {/* The server's sentence, shown as-is. */}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          <button type="submit" className="btn btn-primary" disabled={busy} style={{ width: "100%" }}>
            {busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>

        <p className="auth-switch">
          {mode === "login" ? "No account yet? " : "Already have an account? "}
          <button
            type="button"
            className="linkish"
            onClick={() => {
              setMode(mode === "login" ? "signup" : "login");
              setError(null);
            }}
          >
            {mode === "login" ? "Create one" : "Sign in"}
          </button>
        </p>
      </div>
    </div>
  );
}
