import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { authClient } from './auth-client';
import { useAppAuth } from './WebAuthProvider';

export function CallbackPage(): JSX.Element {
  const [params] = useSearchParams();
  const { user, isAuthenticated } = useAppAuth();
  const navigate = useNavigate();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    if (!isAuthenticated) {
      const next = authClient.acceptGoogleCallback(params);
      if (next) {
        // Force a re-render to update auth state
        window.location.replace('/');
        return;
      }
    }
    navigate('/', { replace: true });
  }, [params, isAuthenticated, navigate]);

  return (
    <div className="app">
      <div className="card hero-card">
        <p className="eyebrow">Autenticação</p>
        <h1>Finalizando login…</h1>
        <p className="lead">
          {user ? `Bem-vindo, ${user.name ?? user.email}.` : 'Validando credenciais do Google.'}
        </p>
      </div>
    </div>
  );
}
