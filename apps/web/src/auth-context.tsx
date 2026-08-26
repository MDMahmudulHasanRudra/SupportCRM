import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, auth, type SessionUser } from './api/client';
import { closeSocket } from './api/realtime';

/**
 * Who is signed in.
 *
 * The session itself lives in an `httpOnly` cookie the JavaScript cannot read; this holds only the
 * profile the API returns, so signing in is "ask the server who I am", never "decode a token".
 */

interface AuthState {
  user: SessionUser | null;
  loading: boolean;
  signIn: (identifier: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  can: (permission: string) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // A 401 here is the ordinary "not signed in yet" case, not an error worth showing.
    auth
      .me()
      .then(setUser)
      .catch((error: unknown) => {
        if (!(error instanceof ApiError) || error.status !== 401) console.warn(error);
      })
      .finally(() => setLoading(false));
  }, []);

  // A session that expires while the console is open. The alternative is an operator stuck on a
  // page where every action fails with the same message and nothing sends them to the login screen.
  useEffect(() => {
    const onExpired = () => {
      setUser((current) => {
        if (current) closeSocket();
        return null;
      });
    };

    globalThis.addEventListener('support-crm:unauthenticated', onExpired);
    return () => globalThis.removeEventListener('support-crm:unauthenticated', onExpired);
  }, []);

  const signIn = useCallback(async (identifier: string, password: string) => {
    const { user: signedIn } = await auth.login(identifier, password);
    setUser(signedIn);
  }, []);

  const signOut = useCallback(async () => {
    await auth.logout().catch(() => undefined);
    // The socket authenticated with the old cookie — drop it rather than leaving it subscribed.
    closeSocket();
    setUser(null);
  }, []);

  const can = useCallback(
    (permission: string) => user?.permissions.includes(permission) ?? false,
    [user],
  );

  const value = useMemo(
    () => ({ user, loading, signIn, signOut, can }),
    [user, loading, signIn, signOut, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
