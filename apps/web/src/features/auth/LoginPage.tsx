import { useAppAuth } from './WebAuthProvider';

export function LoginPage(): JSX.Element {
  const { loginWithRedirect, isAuthenticated, isLoading } = useAppAuth();
  if (isLoading) return <div className="app">Carregando…</div>;
  if (isAuthenticated) return <NavigateToApp />;
  return (
    <div className="app">
      <div className="card">
        <h1>ExtractionStack</h1>
        <p>Analise o stack de qualquer site em segundos.</p>
        <button onClick={() => loginWithRedirect()}>Entrar com Auth0</button>
      </div>
    </div>
  );
}

function NavigateToApp(): JSX.Element {
  window.location.replace('/extract');
  return <div className="app">Redirecionando…</div>;
}
