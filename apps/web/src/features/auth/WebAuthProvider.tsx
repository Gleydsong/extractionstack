import type {
  PropsWithChildren,
  ReactElement} from 'react';
import {
  createContext,
  useContext,
  useMemo,
} from 'react';
import type { Auth0ContextInterface } from '@auth0/auth0-react';
import { Auth0Provider, useAuth0 } from '@auth0/auth0-react';

export interface AppAuth {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: { sub: string; email?: string; name?: string } | undefined;
  loginWithRedirect: () => Promise<void> | void;
  logout: () => Promise<void> | void;
  getAccessTokenSilently: () => Promise<string>;
}

const DEV_AUTH: AppAuth = {
  isAuthenticated: true,
  isLoading: false,
  user: { sub: 'dev|local', email: 'dev@local', name: 'dev' },
  loginWithRedirect: (): void => undefined,
  logout: (): void => undefined,
  getAccessTokenSilently: async (): Promise<string> => 'dev-token',
};

function adapt(real: Auth0ContextInterface): AppAuth {
  return {
    isAuthenticated: real.isAuthenticated,
    isLoading: real.isLoading,
    user: real.user
      ? { sub: real.user.sub ?? '', email: real.user.email, name: real.user.name }
      : undefined,
    loginWithRedirect: () => real.loginWithRedirect(),
    logout: () =>
      real.logout({ logoutParams: { returnTo: window.location.origin } }),
    getAccessTokenSilently: async () => real.getAccessTokenSilently(),
  };
}

const AppAuthContext = createContext<AppAuth>(DEV_AUTH);

export function useAppAuth(): AppAuth {
  return useContext(AppAuthContext);
}

function DevProvider({ children }: PropsWithChildren): ReactElement {
  return <AppAuthContext.Provider value={DEV_AUTH}>{children}</AppAuthContext.Provider>;
}

function RealProvider({ children }: PropsWithChildren): ReactElement {
  const real = useAuth0();
  const value = useMemo(() => adapt(real), [real]);
  return <AppAuthContext.Provider value={value}>{children}</AppAuthContext.Provider>;
}

export function WebAuthProvider({ children }: PropsWithChildren): ReactElement {
  const isDev = (import.meta.env.VITE_AUTH_DEV_MODE as string | undefined) === 'true';
  if (isDev) return <DevProvider>{children}</DevProvider>;

  const domain = import.meta.env.VITE_AUTH0_DOMAIN as string | undefined;
  const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID as string | undefined;
  const audience = import.meta.env.VITE_AUTH0_AUDIENCE as string | undefined;
  const redirectUri =
    (import.meta.env.VITE_AUTH0_REDIRECT_URI as string | undefined) ??
    window.location.origin + '/callback';

  if (!domain || !clientId || !audience) {
    return (
      <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
        <h2>Auth0 env vars missing</h2>
        <p>
          Set <code>VITE_AUTH0_DOMAIN</code>, <code>VITE_AUTH0_CLIENT_ID</code>, and{' '}
          <code>VITE_AUTH0_AUDIENCE</code>, or set <code>VITE_AUTH_DEV_MODE=true</code> to bypass
          auth in dev.
        </p>
      </div>
    );
  }

  return (
    <Auth0Provider
      domain={domain}
      clientId={clientId}
      authorizationParams={{ redirect_uri: redirectUri, audience }}
      cacheLocation="localstorage"
    >
      <RealProvider>{children}</RealProvider>
    </Auth0Provider>
  );
}
