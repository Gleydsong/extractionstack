export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  picture?: string | null;
  role: 'USER' | 'ADMIN';
}

export interface AuthSuccess {
  token: string;
  user: AuthUser;
}

export interface AuthProviders {
  local: boolean;
  google: boolean;
  dev: boolean;
}

const TOKEN_KEY = 'extractionstack.token';
const USER_KEY = 'extractionstack.user';

function isUser(value: unknown): value is AuthUser {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.email === 'string' &&
    (v.name === null || typeof v.name === 'string') &&
    (v.role === 'USER' || v.role === 'ADMIN')
  );
}

function readStoredUser(): AuthUser | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isUser(parsed)) return parsed;
  } catch {
    /* fall through */
  }
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(TOKEN_KEY);
  return null;
}

function readStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

async function parseError(res: Response): Promise<never> {
  let message = `Falha na requisição (${res.status})`;
  try {
    const body = (await res.json()) as { message?: string };
    if (typeof body?.message === 'string' && body.message) message = body.message;
  } catch {
    /* ignore */
  }
  throw new Error(message);
}

function persist(token: string, user: AuthUser): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export const authClient = {
  isAuthenticated(): boolean {
    return Boolean(readStoredToken() && readStoredUser());
  },

  getToken(): string | null {
    return readStoredToken();
  },

  getUser(): AuthUser | null {
    return readStoredUser();
  },

  async signup(input: { email: string; password: string; name: string }): Promise<AuthUser> {
    const res = await fetch('/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) await parseError(res);
    const body = (await res.json()) as AuthSuccess;
    persist(body.token, body.user);
    return body.user;
  },

  async login(input: { email: string; password: string }): Promise<AuthUser> {
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) await parseError(res);
    const body = (await res.json()) as AuthSuccess;
    persist(body.token, body.user);
    return body.user;
  },

  async devLogin(): Promise<AuthUser> {
    const res = await fetch('/auth/dev', { method: 'POST' });
    if (!res.ok) await parseError(res);
    const body = (await res.json()) as AuthSuccess;
    persist(body.token, body.user);
    return body.user;
  },

  acceptGoogleCallback(query: URLSearchParams): AuthUser | null {
    const token = query.get('token');
    const email = query.get('email') ?? '';
    const name = query.get('name') ?? '';
    const role = (query.get('role') ?? 'USER') as 'USER' | 'ADMIN';
    if (!token) return null;
    const user: AuthUser = {
      id: email,
      email,
      name: name || null,
      role,
    };
    persist(token, user);
    return user;
  },

  logout(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },

  async fetchProviders(): Promise<AuthProviders> {
    try {
      const res = await fetch('/auth/providers');
      if (!res.ok) return { local: true, google: false, dev: false };
      return (await res.json()) as AuthProviders;
    } catch {
      return { local: true, google: false, dev: false };
    }
  },

  startGoogleLogin(): void {
    window.location.href = '/auth/google';
  },
};

/**
 * Wraps a fetch to inject the bearer token. Returns the original Response.
 */
export async function authedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const token = readStoredToken();
  const headers = new Headers(init.headers ?? {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}
