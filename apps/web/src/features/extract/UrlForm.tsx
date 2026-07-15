import { useState, FormEvent } from 'react';

interface UrlFormProps {
  isLoading: boolean;
  onSubmit: (url: string) => string | null;
}

export function UrlForm({ isLoading, onSubmit }: UrlFormProps): JSX.Element {
  const [url, setUrl] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    const err = onSubmit(url.trim());
    setValidationError(err);
  }

  return (
    <form onSubmit={handleSubmit}>
      <label htmlFor="url" style={{ display: 'block', marginBottom: 6 }}>
        URL do site
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          id="url"
          type="url"
          placeholder="https://exemplo.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
        />
        <button type="submit" disabled={isLoading || url.trim().length === 0}>
          {isLoading ? 'Extraindo…' : 'Extrair'}
        </button>
      </div>
      {validationError ? (
        <div className="meta" style={{ color: 'var(--danger)', marginTop: 6 }}>
          {validationError}
        </div>
      ) : null}
    </form>
  );
}
