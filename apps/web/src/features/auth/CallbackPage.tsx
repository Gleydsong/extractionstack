import { useEffect } from 'react';
import { useAppAuth } from './WebAuthProvider';
import { useNavigate } from 'react-router-dom';

export function CallbackPage(): JSX.Element {
  const { isLoading, isAuthenticated } = useAppAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isLoading && isAuthenticated) navigate('/extract', { replace: true });
  }, [isLoading, isAuthenticated, navigate]);

  return <div className="app">Finalizando login…</div>;
}
