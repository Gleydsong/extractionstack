import { CreateExtractionSchema } from '@extractionstack/shared';
import type { ExtractionApiClient } from '../../lib/api-client';
import { Header } from '../auth/Header';
import { ReportView } from '../extract/ReportView';
import { UrlForm } from '../extract/UrlForm';
import { JobStatus } from './JobStatus';
import { useExtractionApiClient } from './useExtractionApiClient';
import { useExtractionJob } from './useExtractionJob';

export function DashboardPage({ client: injected }: { client?: ExtractionApiClient }): JSX.Element {
  const client = useExtractionApiClient(injected);
  const { job, isSubmitting, error, submit, cancel } = useExtractionJob(client);
  const canCancel = job?.status === 'QUEUED' || job?.status === 'RUNNING';

  return (
    <div className="app">
      <Header />
      <main>
        <section className="card hero-card">
          <p className="eyebrow">Análise técnica baseada em evidências</p>
          <h1>Descubra a stack de um site</h1>
          <p className="lead">
            O crawler observa a página pública e identifica tecnologias, arquitetura, design,
            performance e infraestrutura com grau de confiança.
          </p>
          <UrlForm
            isLoading={isSubmitting}
            onSubmit={(rawUrl) => {
              const parsed = CreateExtractionSchema.safeParse({ url: rawUrl });
              if (!parsed.success) return parsed.error.issues[0]?.message ?? 'URL inválida';
              void submit(parsed.data.url);
              return null;
            }}
          />
        </section>

        {error ? <div className="card error-panel" role="alert">{error}</div> : null}
        {job ? (
          <section className="card">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Job {job.id}</p>
                <h2>Estado da extração</h2>
              </div>
              {canCancel ? <button onClick={() => void cancel()}>Cancelar</button> : null}
            </div>
            <JobStatus job={job} />
          </section>
        ) : null}
        {job?.status === 'SUCCEEDED' && job.report ? (
          <ReportView report={job.report} url={job.requestedUrl} />
        ) : null}
      </main>
    </div>
  );
}
