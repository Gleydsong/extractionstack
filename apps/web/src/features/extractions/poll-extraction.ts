import type { ExtractionJob } from '@extractionstack/shared';

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

type GetJob = (id: string, signal?: AbortSignal) => Promise<ExtractionJob>;
type Wait = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export async function pollExtraction(
  getJob: GetJob,
  id: string,
  onUpdate: (job: ExtractionJob) => void,
  signal: AbortSignal,
  wait: Wait = abortableWait,
): Promise<ExtractionJob> {
  let delay = 500;
  while (!signal.aborted) {
    const job = await getJob(id, signal);
    onUpdate(job);
    if (TERMINAL.has(job.status)) return job;
    if (signal.aborted) throw abortError();
    await wait(delay, signal);
    delay = Math.min(delay * 2, 5_000);
  }
  throw abortError();
}

function abortableWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeout);
        reject(abortError());
      },
      { once: true },
    );
  });
}

function abortError(): DOMException {
  return new DOMException('Polling aborted', 'AbortError');
}
