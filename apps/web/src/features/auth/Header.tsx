import { useAppAuth } from './WebAuthProvider';
import { Link } from 'react-router-dom';

export function Header(): JSX.Element {
  const { user, isAuthenticated, logout, loginWithRedirect } = useAppAuth();
  return (
    <header className="header">
      <Link className="brand" to="/">ExtractionStack</Link>
      <nav>
        {isAuthenticated ? (
          <>
            <Link className="nav-link" to="/">Analisar</Link>
            <Link className="nav-link" to="/history">Histórico</Link>
            <span style={{ marginRight: '0.75rem' }}>{user?.name ?? user?.email}</span>
            <button onClick={() => void logout()}>Sair</button>
          </>
        ) : (
          <button onClick={() => loginWithRedirect()}>Entrar</button>
        )}
      </nav>
    </header>
  );
}
