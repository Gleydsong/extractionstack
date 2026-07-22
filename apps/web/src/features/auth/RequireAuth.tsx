import type { PropsWithChildren } from 'react';
import { Navigate } from 'react-router-dom';
import { useAppAuth } from './WebAuthProvider';

export function RequireAuth({ children }: PropsWithChildren): JSX.Element {
  const { isAuthenticated } = useAppAuth();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
