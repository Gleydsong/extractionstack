import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ExtractionListResponse } from '@extractionstack/shared';
import { Header } from '../auth/Header';
import { JobStatus } from './JobStatus';
import { useExtractionApiClient } from './useExtractionApiClient';

export function HistoryPage(): JSX.Element {
  const client = useExtractionApiClient();
  const [history, setHistory] = useState<ExtractionListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void client
      .listJobs({ limit: 50, sort: 'createdAt:desc' })
      .then((result) => active && setHistory(result))
      .catch((cause: unknown) => active && setError(cause instanceof Error ? cause.message : 'request failed'));
    return () => {
      active = false;
    };
  }, [client]);

  return (
    <div className="app">
      <Header />
      <main className="card">
        <p className="eyebrow">Histórico persistido</p>
        <h1>Extrações</h1>
        {error ? <div className="error-panel" role="alert">{error}</div> : null}
        {history && history.items.length === 0 ? <p className="meta">Nenhuma extração ainda.</p> : null}
        <div className="history-list">
          {history?.items.map((job) => (
            <Link className="history-item" to={`/extractions/${job.id}`} key={job.id}>
              <span>{job.requestedUrl}</span>
              <JobStatus job={job} />
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
