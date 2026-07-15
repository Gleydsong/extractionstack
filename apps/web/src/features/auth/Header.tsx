import { useAppAuth } from './WebAuthProvider';

export function Header(): JSX.Element {
  const { user, isAuthenticated, logout, loginWithRedirect } = useAppAuth();
  return (
    <header className="header">
      <div className="brand">ExtractionStack</div>
      <nav>
        {isAuthenticated ? (
          <>
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
