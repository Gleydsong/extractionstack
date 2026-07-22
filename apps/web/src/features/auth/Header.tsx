import { NavLink, useNavigate } from 'react-router-dom';
import { useAppAuth } from './WebAuthProvider';

export function Header(): JSX.Element {
  const { user, isAuthenticated, logout } = useAppAuth();
  const navigate = useNavigate();
  return (
    <header className="header">
      <NavLink className="brand" to="/">
        ExtractionStack
      </NavLink>
      <nav>
        {isAuthenticated ? (
          <>
            <NavLink className="nav-link" to="/" end>
              Analisar
            </NavLink>
            <NavLink className="nav-link" to="/history">
              Histórico
            </NavLink>
            <span style={{ marginRight: '0.75rem', color: 'var(--muted)' }}>
              {user?.name ?? user?.email}
            </span>
            <button type="button" onClick={() => void logout()}>
              Sair
            </button>
          </>
        ) : (
          <button type="button" onClick={() => navigate('/login')}>
            Entrar
          </button>
        )}
      </nav>
    </header>
  );
}
