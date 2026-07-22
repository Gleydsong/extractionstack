import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { useAppAuth } from './WebAuthProvider';

type Mode = 'login' | 'signup';

interface FormErrors {
  email?: string;
  password?: string;
  name?: string;
  form?: string;
}

function GoogleIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47c-.28 1.4-1.06 2.6-2.27 3.4v2.84h3.67c2.16-1.99 3.42-4.92 3.42-8.48z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.07 7.93-2.91l-3.67-2.84c-1.02.69-2.34 1.1-4.26 1.1-3.27 0-6.05-2.21-7.04-5.18H1.18v3.25A12 12 0 0 0 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M4.96 14.18a7.21 7.21 0 0 1 0-4.36V6.57H1.18a12 12 0 0 0 0 10.86l3.78-3.25z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.43-3.43C17.95 1.16 15.24 0 12 0 7.31 0 3.26 2.69 1.18 6.57l3.78 3.25C5.95 6.96 8.73 4.75 12 4.75z"
      />
    </svg>
  );
}

export function LoginPage(): JSX.Element {
  const { isAuthenticated, signup, login, loginWithGoogle, devLogin, providers } = useAppAuth();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  function validate(): FormErrors {
    const e: FormErrors = {};
    if (!email.trim()) e.email = 'Informe seu e-mail.';
    else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) e.email = 'E-mail inválido.';
    if (!password) e.password = 'Informe sua senha.';
    else if (mode === 'signup' && password.length < 8) e.password = 'A senha precisa ter pelo menos 8 caracteres.';
    if (mode === 'signup' && !name.trim()) e.name = 'Informe seu nome.';
    return e;
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    const v = validate();
    setErrors(v);
    if (Object.keys(v).length > 0) return;
    setSubmitting(true);
    try {
      if (mode === 'login') await login({ email: email.trim(), password });
      else await signup({ email: email.trim(), password, name: name.trim() });
    } catch (err) {
      setErrors({ form: err instanceof Error ? err.message : 'Falha ao autenticar.' });
    } finally {
      setSubmitting(false);
    }
  }

  const passwordAutocomplete = mode === 'login' ? 'current-password' : 'new-password';

  return (
    <div className="app">
      <div className="card hero-card login-card">
        <p className="eyebrow">Análise técnica baseada em evidências</p>
        <h1>ExtractionStack</h1>
        <p className="lead">
          Identifique o stack de qualquer site público em segundos. Crie uma conta
          ou entre com Google para acessar o histórico e iniciar novas extrações.
        </p>

        {providers.google ? (
          <button
            type="button"
            className="google-btn"
            onClick={loginWithGoogle}
            disabled={submitting}
          >
            <GoogleIcon />
            Continuar com Google
          </button>
        ) : null}

        {providers.google && providers.local ? <div className="divider"><span>ou</span></div> : null}

        <div className="tabs" role="tablist" aria-label="Modo de autenticação">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'login'}
            className={`tab ${mode === 'login' ? 'active' : ''}`}
            onClick={() => {
              setMode('login');
              setErrors({});
            }}
          >
            Entrar
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'signup'}
            className={`tab ${mode === 'signup' ? 'active' : ''}`}
            onClick={() => {
              setMode('signup');
              setErrors({});
            }}
          >
            Criar conta
          </button>
        </div>

        <form onSubmit={onSubmit} noValidate className="form-stack">
          {mode === 'signup' ? (
            <label className="field">
              <span className="field-label">Nome</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Seu nome"
                autoComplete="name"
                required
              />
              {errors.name ? <span className="field-error">{errors.name}</span> : null}
            </label>
          ) : null}

          <label className="field">
            <span className="field-label">E-mail</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="voce@empresa.com"
              autoComplete="email"
              required
            />
            {errors.email ? <span className="field-error">{errors.email}</span> : null}
          </label>

          <label className="field">
            <span className="field-label">Senha</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'signup' ? 'Crie uma senha (8+ caracteres)' : 'Sua senha'}
              autoComplete={passwordAutocomplete}
              required
              minLength={mode === 'signup' ? 8 : 1}
            />
            {errors.password ? <span className="field-error">{errors.password}</span> : null}
          </label>

          {errors.form ? <p className="form-error">{errors.form}</p> : null}

          <button type="submit" className="primary submit-btn" disabled={submitting}>
            {submitting
              ? 'Aguarde…'
              : mode === 'login'
                ? 'Entrar'
                : 'Criar conta e entrar'}
          </button>
        </form>

        {providers.dev ? (
          <>
            <div className="divider"><span>modo dev</span></div>
            <button
              type="button"
              className="dev-btn"
              onClick={() => void devLogin()}
              disabled={submitting}
            >
              Entrar como dev (sem credenciais)
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
