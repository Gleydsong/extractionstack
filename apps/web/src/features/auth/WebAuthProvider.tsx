import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { authClient, type AuthProviders, type AuthUser } from './auth-client';

interface AppAuthState {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  providers: AuthProviders;
  signup: (input: { email: string; password: string; name: string }) => Promise<AuthUser>;
  login: (input: { email: string; password: string }) => Promise<AuthUser>;
  loginWithGoogle: () => void;
  devLogin: () => Promise<AuthUser>;
  logout: () => void;
}

const AppAuthContext = createContext<AppAuthState | null>(null);

const emptyProviders: AuthProviders = { local: true, google: false, dev: false };

export function WebAuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<AuthUser | null>(() => authClient.getUser());
  const [providers, setProviders] = useState<AuthProviders>(emptyProviders);

  useEffect(() => {
    let cancelled = false;
    void authClient.fetchProviders().then((p) => {
      if (!cancelled) setProviders(p);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const signup = useCallback<AppAuthState['signup']>(async (input) => {
    const next = await authClient.signup(input);
    setUser(next);
    return next;
  }, []);

  const login = useCallback<AppAuthState['login']>(async (input) => {
    const next = await authClient.login(input);
    setUser(next);
    return next;
  }, []);

  const devLogin = useCallback<AppAuthState['devLogin']>(async () => {
    const next = await authClient.devLogin();
    setUser(next);
    return next;
  }, []);

  const loginWithGoogle = useCallback(() => {
    authClient.startGoogleLogin();
  }, []);

  const logout = useCallback(() => {
    authClient.logout();
    setUser(null);
  }, []);

  const value = useMemo<AppAuthState>(
    () => ({
      user,
      isLoading: false,
      isAuthenticated: user !== null,
      providers,
      signup,
      login,
      loginWithGoogle,
      devLogin,
      logout,
    }),
    [user, providers, signup, login, loginWithGoogle, devLogin, logout],
  );

  return <AppAuthContext.Provider value={value}>{children}</AppAuthContext.Provider>;
}

export function useAppAuth(): AppAuthState {
  const ctx = useContext(AppAuthContext);
  if (!ctx) throw new Error('useAppAuth must be used inside WebAuthProvider');
  return ctx;
}
