import { useState } from 'react';
import type { ExtractRequest, ExtractionReport } from '@extractionstack/shared';
import { ErrorResponseSchema } from '@extractionstack/shared';
import { authClient } from '../auth/auth-client';

interface State {
  isLoading: boolean;
  error: { message: string; hint?: string } | null;
  report: ExtractionReport | null;
}

const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

export function useExtract(): State & { run: (req: ExtractRequest) => Promise<void> } {
  const [state, setState] = useState<State>({ isLoading: false, error: null, report: null });

  async function run(req: ExtractRequest): Promise<void> {
    setState({ isLoading: true, error: null, report: null });
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const token = authClient.getToken();
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(`${API_BASE_URL}/api/extract`, {
        method: 'POST',
        headers,
        body: JSON.stringify(req),
      });
      const json: unknown = await res.json();
      if (!res.ok) {
        const parsed = ErrorResponseSchema.safeParse(json);
        const message = parsed.success ? parsed.data.message : `request failed (${res.status})`;
        const hint = parsed.success ? parsed.data.hint : undefined;
        setState({ isLoading: false, error: { message, hint }, report: null });
        return;
      }
      setState({ isLoading: false, error: null, report: json as ExtractionReport });
    } catch (err) {
      setState({
        isLoading: false,
        error: { message: (err as Error).message ?? 'network error' },
        report: null,
      });
    }
  }

  return { ...state, run };
}
