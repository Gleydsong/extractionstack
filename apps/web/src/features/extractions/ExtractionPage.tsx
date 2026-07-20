import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ExtractionJob } from '@extractionstack/shared';
import { Header } from '../auth/Header';
import { ReportView } from '../extract/ReportView';
import { JobStatus } from './JobStatus';
import { pollExtraction } from './poll-extraction';
import { useExtractionApiClient } from './useExtractionApiClient';

export function ExtractionPage(): JSX.Element {
  const { id = '' } = useParams();
  const client = useExtractionApiClient();
  const [job, setJob] = useState<ExtractionJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void pollExtraction(
      (jobId, signal) => client.getJob(jobId, signal),
      id,
      setJob,
      controller.signal,
    ).catch((cause: unknown) => {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
        setError(cause instanceof Error ? cause.message : 'request failed');
      }
    });
    return () => controller.abort();
  }, [client, id]);

  return (
    <div className="app">
      <Header />
      <main>
        {error ? (
          <div className="card error-panel" role="alert">
            {error}
          </div>
        ) : null}
        {job ? (
          <section className="card">
            <h1>Extração</h1>
            <JobStatus job={job} />
          </section>
        ) : null}
        {job?.status === 'SUCCEEDED' && job.report ? (
          <>
            <div className="extraction-prompt-action">
              <div>
                <h2>Transformar relatório</h2>
                <p>
                  Crie um prompt em linguagem natural usando somente evidências permitidas desta
                  extração.
                </p>
              </div>
              <Link
                className="primary-action"
                to={`/extractions/${encodeURIComponent(job.id)}/prompts/new`}
              >
                Gerar prompt
              </Link>
            </div>
            <ReportView report={job.report} url={job.requestedUrl} />
          </>
        ) : null}
      </main>
    </div>
  );
}
