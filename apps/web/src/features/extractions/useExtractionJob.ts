import { useEffect, useRef, useState } from 'react';
import type { ExtractionJob } from '@extractionstack/shared';
import type { ExtractionApiClient } from '../../lib/api-client';
import { pollExtraction } from './poll-extraction';

interface ExtractionJobState {
  job: ExtractionJob | null;
  isSubmitting: boolean;
  error: string | null;
}

export function useExtractionJob(client: ExtractionApiClient) {
  const [state, setState] = useState<ExtractionJobState>({
    job: null,
    isSubmitting: false,
    error: null,
  });
  const polling = useRef<AbortController | null>(null);

  useEffect(() => () => polling.current?.abort(), []);

  async function submit(url: string): Promise<void> {
    polling.current?.abort();
    const controller = new AbortController();
    polling.current = controller;
    setState({ job: null, isSubmitting: true, error: null });
    try {
      const key = `extract:${crypto.randomUUID()}`;
      const created = await client.createJob(url, key);
      setState({ job: created, isSubmitting: false, error: null });
      await pollExtraction(
        (id, signal) => client.getJob(id, signal),
        created.id,
        (job) => setState({ job, isSubmitting: false, error: null }),
        controller.signal,
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setState((current) => ({
        ...current,
        isSubmitting: false,
        error: error instanceof Error ? error.message : 'extraction failed',
      }));
    }
  }

  async function cancel(): Promise<void> {
    if (!state.job) return;
    polling.current?.abort();
    try {
      const job = await client.cancelJob(state.job.id);
      setState({ job, isSubmitting: false, error: null });
    } catch (error) {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : 'cancellation failed',
      }));
    }
  }

  return { ...state, submit, cancel };
}
