import type { ExtractionJob } from '@extractionstack/shared';

const LABELS: Record<ExtractionJob['status'], string> = {
  QUEUED: 'Na fila',
  RUNNING: 'Analisando',
  SUCCEEDED: 'Concluída',
  FAILED: 'Falhou',
  CANCEL_REQUESTED: 'Cancelando',
  CANCELLED: 'Cancelada',
};

export function JobStatus({ job }: { job: ExtractionJob }): JSX.Element {
  return (
    <div className="job-status" aria-live="polite">
      <span className={`status ${job.status.toLowerCase()}`}>{LABELS[job.status]}</span>
      <span className="meta">Tentativa {job.attempts}/{job.maxAttempts}</span>
      {job.errorMessage ? <span className="error-text">{job.errorMessage}</span> : null}
    </div>
  );
}
