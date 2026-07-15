import type { PropsWithChildren } from 'react';
import { useAppAuth } from './WebAuthProvider';

export function RequireAuth({ children }: PropsWithChildren): JSX.Element {
  const { isAuthenticated, isLoading, loginWithRedirect } = useAppAuth();
  if (isLoading) return <div className="app">Carregando…</div>;
  if (!isAuthenticated) {
    void loginWithRedirect();
    return <div className="app">Redirecionando para login…</div>;
  }
  return <>{children}</>;
}
