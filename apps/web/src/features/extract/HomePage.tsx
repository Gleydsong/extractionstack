import { useState } from 'react';
import { ExtractRequestSchema } from '@extractionstack/shared';
import { useExtract } from './useExtract';
import { UrlForm } from './UrlForm';
import { ReportView } from './ReportView';
import { Header } from '../auth/Header';

export function HomePage(): JSX.Element {
  const { run, isLoading, error, report } = useExtract();
  const [lastUrl, setLastUrl] = useState<string | null>(null);

  return (
    <div className="app">
      <Header />
      <div className="card">
        <h1 style={{ marginTop: 0 }}>Extrair stack</h1>
        <UrlForm
          isLoading={isLoading}
          onSubmit={(rawUrl) => {
            const parsed = ExtractRequestSchema.safeParse({ url: rawUrl });
            if (!parsed.success) {
              return parsed.error.issues[0]?.message ?? 'URL inválida';
            }
            setLastUrl(rawUrl);
            void run(parsed.data);
            return null;
          }}
        />
        {error ? (
          <div className="card" style={{ borderColor: 'var(--danger)' }}>
            <strong>Erro:</strong> {error.message}
            {error.hint ? <div className="meta">{error.hint}</div> : null}
          </div>
        ) : null}
      </div>
      {report ? <ReportView report={report} url={lastUrl ?? report.url} /> : null}
    </div>
  );
}
