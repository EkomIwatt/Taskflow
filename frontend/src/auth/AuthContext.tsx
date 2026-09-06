/**
 * Auth, carried over from LedgerLite unchanged in shape.
 *
 * The access token lives in memory ONLY (see api/http.ts). Session survival
 * across a reload comes from the httpOnly refresh cookie this JavaScript
 * cannot read -- that is the whole point of the design, not an inconvenience.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as api from "../api/endpoints";
import { setAccessToken, setSessionExpiredHandler } from "../api/http";
import type { User } from "../types/contracts";

type AuthStatus = "booting" | "authenticated" | "anonymous";

interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  signup: (email: string, password: string, displayName: string | null) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const [status, setStatus] = useState<AuthStatus>("booting");
  const [user, setUser] = useState<User | null>(null);
  const booted = useRef(false);

  useEffect(() => {
    // React 18+ StrictMode double-invokes effects in dev; booting twice would
    // rotate the refresh cookie twice and invalidate the first token.
    if (booted.current) return;
    booted.current = true;

    let cancelled = false;

    // Boot with ONE refresh: 200 -> hydrate and render; 401 -> login screen.
    // The loading state matters -- never flash the login page at an already
    // authenticated user.
    void (async () => {
      try {
        const session = await api.refresh();
        setAccessToken(session.access_token);
        const me = await api.me();
        if (cancelled) return;
        setUser(me);
        setStatus("authenticated");
      } catch {
        if (cancelled) return;
        setAccessToken(null);
        setUser(null);
        setStatus("anonymous");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // A refresh that fails mid-session is unrecoverable: drop to the login
    // screen rather than looping.
    setSessionExpiredHandler(() => {
      setUser(null);
      setStatus("anonymous");
    });
    return () => setSessionExpiredHandler(() => {});
  }, []);

  const adopt = useCallback((session: { access_token: string; user: User }) => {
    setAccessToken(session.access_token);
    setUser(session.user);
    setStatus("authenticated");
  }, []);

  const signup = useCallback(
    async (email: string, password: string, displayName: string | null) => {
      adopt(await api.signup({ email, password, display_name: displayName }));
    },
    [adopt],
  );

  const login = useCallback(
    async (email: string, password: string) => {
      adopt(await api.login({ email, password }));
    },
    [adopt],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setAccessToken(null);
      setUser(null);
      setStatus("anonymous");
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, signup, login, logout }),
    [status, user, signup, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside an AuthProvider.");
  return ctx;
}
