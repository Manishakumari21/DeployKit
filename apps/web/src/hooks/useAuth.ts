import { useCallback, useEffect, useState } from "react";
import { ApiError, fetchSession, login as apiLogin, logout as apiLogout, register as apiRegister } from "../lib/api";
import type { AuthUser } from "../types";

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

export function isUnauthorized(e: unknown): boolean {
  return e instanceof ApiError && e.status === 401;
}

export function useAuth() {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const me = await fetchSession();
      setUser(me);
      setStatus("authenticated");
      setError(null);
      return me;
    } catch (e) {
      setUser(null);
      setStatus("unauthenticated");
      if (!isUnauthorized(e)) {
        setError(e instanceof Error ? e.message : "Could not reach the API");
      }
      return null;
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void refresh();
    });
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    setBusy(true);
    setError(null);
    try {
      const me = await apiLogin({ email, password });
      setUser(me);
      setStatus("authenticated");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login failed");
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const register = useCallback(async (email: string, password: string) => {
    setBusy(true);
    setError(null);
    try {
      await apiRegister({ email, password });

      const me = await apiLogin({ email, password });
      setUser(me);
      setStatus("authenticated");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Registration failed");
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const logout = useCallback(async () => {
    setBusy(true);
    try {
      await apiLogout();
    } catch {
    } finally {
      setUser(null);
      setStatus("unauthenticated");
      setBusy(false);
    }
  }, []);

  return { status, user, busy, error, login, register, logout, refresh };
}
