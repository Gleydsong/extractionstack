import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { ExtractionApiClient } from '../../lib/api-client';
import { DashboardPage } from './DashboardPage';

const queued = {
  id: 'cm1234567890abcdef',
  requestedUrl: 'https://example.com',
  normalizedUrl: 'https://example.com/',
  status: 'QUEUED' as const,
  attempts: 0,
  maxAttempts: 3,
  queuedAt: '2026-07-15T12:00:00.000Z',
  createdAt: '2026-07-15T12:00:00.000Z',
  updatedAt: '2026-07-15T12:00:00.000Z',
};

describe('DashboardPage', () => {
  it('submits a URL and renders the persisted successful report', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      'cb6d0478-a915-4d09-bde4-b6270d677e6a',
    );
    const client = {
      createJob: vi.fn().mockResolvedValue(queued),
      getJob: vi.fn().mockResolvedValue({
        ...queued,
        status: 'SUCCEEDED',
        report: {
          url: queued.requestedUrl,
          finalUrl: queued.normalizedUrl,
          fetchedAt: queued.createdAt,
          durationMs: 123,
          sections: {},
        },
      }),
      cancelJob: vi.fn(),
    } as unknown as ExtractionApiClient;

    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <DashboardPage client={client} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('URL do site'), {
      target: { value: 'https://example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Extrair' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Relatório' })).toBeInTheDocument());
    expect(client.createJob).toHaveBeenCalledWith(
      'https://example.com',
      'extract:cb6d0478-a915-4d09-bde4-b6270d677e6a',
    );
  });
});
