import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { PromptWizardPage } from './PromptWizardPage';
import type { PromptApi } from './usePromptApi';

function api(): PromptApi {
  return {
    listProviders: vi.fn().mockResolvedValue([
      {
        provider: 'OPENAI',
        credentialModes: ['API_KEY', 'PLATFORM_CREDITS'],
        models: ['model-test'],
        contextWindowTokens: 10000,
        maxOutputTokens: 1000,
        supportsStructuredOutput: true,
        supportsCancellation: false,
        supportsCredentialRefresh: false,
        previewEligible: true,
        enabled: true,
        circuitBreakerOpen: false,
      },
    ]),
    listConnections: vi.fn().mockResolvedValue([]),
    estimateCost: vi.fn().mockResolvedValue({
      provider: 'OPENAI',
      model: 'model-test',
      maximumInputTokens: 2400,
      maximumOutputTokens: 1000,
      maximumCostMinor: '37',
      pricingVersion: 'pricing-2026-07',
      quotedAt: '2026-07-17T10:00:00.000Z',
    }),
  } as unknown as PromptApi;
}

describe('PromptWizardPage', () => {
  it('preserves guided fields and free instructions while reviewing', async () => {
    render(
      <MemoryRouter initialEntries={['/extractions/cm1234567890extract/prompts/new']}>
        <Routes>
          <Route path="/extractions/:id/prompts/new" element={<PromptWizardPage api={api()} />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Tipo de criação'), {
      target: { value: 'application' },
    });
    fireEvent.change(screen.getByLabelText('Objetivo'), {
      target: { value: 'Criar uma aplicação acessível.' },
    });
    fireEvent.change(screen.getByLabelText('Público-alvo'), {
      target: { value: 'Desenvolvedores' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    expect(await screen.findByRole('heading', { name: '2. Requisitos' })).toHaveFocus();
    fireEvent.change(screen.getByLabelText('Idioma do prompt'), {
      target: { value: 'en-US' },
    });
    fireEvent.change(screen.getByLabelText('Nível de detalhe'), {
      target: { value: 'complete' },
    });
    fireEvent.change(screen.getByLabelText('Instruções livres'), {
      target: { value: 'Use arquitetura modular.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Revisar' }));
    expect(await screen.findByRole('heading', { name: /revise geração/i })).toHaveFocus();
    expect(screen.getByText('Use arquitetura modular.')).toBeVisible();
    expect(screen.getByText('en-US')).toBeVisible();
    expect(screen.getByText('complete')).toBeVisible();
    expect(screen.getByText('universal')).toBeVisible();
    expect(screen.getByText(/seções do relatório enviadas/i)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }));
    expect(screen.getByLabelText('Instruções livres')).toHaveValue('Use arquitetura modular.');
  });

  it('shows a required platform-credit ceiling and consent without inventing a price', async () => {
    render(
      <MemoryRouter initialEntries={['/extractions/cm1234567890extract/prompts/new']}>
        <Routes>
          <Route path="/extractions/:id/prompts/new" element={<PromptWizardPage api={api()} />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Objetivo'), {
      target: { value: 'Criar uma aplicação acessível.' },
    });
    fireEvent.change(screen.getByLabelText('Público-alvo'), {
      target: { value: 'Desenvolvedores' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Revisar' }));
    expect(await screen.findByText(/37 unidades mínimas/i)).toBeVisible();
    expect(screen.getByText(/pricing-2026-07/i)).toBeVisible();
    expect(screen.getByText(/17\/07\/2026/i)).toBeVisible();
    expect(screen.getByLabelText(/teto de cobrança/i)).toHaveValue('37');
    expect(screen.getByLabelText(/teto de cobrança/i)).toBeRequired();
    expect(screen.getByRole('checkbox', { name: /autorizo a cobrança real/i })).toBeRequired();
    expect(screen.getByText(/não é uma cobrança/i)).toBeVisible();
    expect(screen.getByText(/entrada máxima: 2\.400 tokens/i)).toBeVisible();
    expect(screen.getByText(/saída máxima: 1\.000 tokens/i)).toBeVisible();
  });

  it('discards a stale quote when wizard input changes', async () => {
    const client = api();
    const first = deferred<Awaited<ReturnType<PromptApi['estimateCost']>>>();
    const second = deferred<Awaited<ReturnType<PromptApi['estimateCost']>>>();
    client.estimateCost = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(
      <MemoryRouter initialEntries={['/extractions/cm1234567890extract/prompts/new']}>
        <Routes>
          <Route path="/extractions/:id/prompts/new" element={<PromptWizardPage api={client} />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Objetivo'), {
      target: { value: 'Criar aplicação acessível.' },
    });
    fireEvent.change(screen.getByLabelText('Público-alvo'), {
      target: { value: 'Desenvolvedores' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Revisar' }));
    await waitFor(() => expect(client.estimateCost).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }));
    fireEvent.change(screen.getByLabelText('Instruções livres'), {
      target: { value: 'Nova regra.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Revisar' }));
    await waitFor(() => expect(client.estimateCost).toHaveBeenCalledTimes(2));
    second.resolve({
      provider: 'OPENAI',
      model: 'model-test',
      maximumInputTokens: 2500,
      maximumOutputTokens: 900,
      maximumCostMinor: '48',
      pricingVersion: 'pricing-new',
      quotedAt: '2026-07-17T11:00:00.000Z',
    });
    expect(await screen.findByText(/48 unidades mínimas/i)).toBeVisible();
    first.resolve({
      provider: 'OPENAI',
      model: 'model-test',
      maximumInputTokens: 2400,
      maximumOutputTokens: 1000,
      maximumCostMinor: '37',
      pricingVersion: 'pricing-old',
      quotedAt: '2026-07-17T10:00:00.000Z',
    });
    await Promise.resolve();
    expect(screen.queryByText(/37 unidades mínimas/i)).not.toBeInTheDocument();
  });

  it('associates audience validation and focuses the invalid field', async () => {
    render(
      <MemoryRouter initialEntries={['/extractions/cm1234567890extract/prompts/new']}>
        <Routes>
          <Route path="/extractions/:id/prompts/new" element={<PromptWizardPage api={api()} />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Objetivo'), {
      target: { value: 'Criar uma aplicação acessível.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    const audience = screen.getByLabelText('Público-alvo');
    expect(audience).toHaveAttribute('aria-describedby', 'audience-error');
    expect(audience).toHaveFocus();
  });

  it('aborts active generation polling when unmounted', async () => {
    const pendingApi = api();
    const abortSeen = vi.fn();
    pendingApi.createProject = vi.fn().mockResolvedValue({ id: 'cm1234567890project' });
    pendingApi.generate = vi.fn().mockResolvedValue({ id: 'cm1234567890job' });
    pendingApi.getJob = vi.fn((_id, signal) => {
      signal?.addEventListener('abort', abortSeen, { once: true });
      return new Promise(() => undefined);
    });
    const view = render(
      <MemoryRouter initialEntries={['/extractions/cm1234567890extract/prompts/new']}>
        <Routes>
          <Route
            path="/extractions/:id/prompts/new"
            element={<PromptWizardPage api={pendingApi} />}
          />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Objetivo'), {
      target: { value: 'Criar uma aplicação acessível.' },
    });
    fireEvent.change(screen.getByLabelText('Público-alvo'), {
      target: { value: 'Desenvolvedores' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Revisar' }));
    await screen.findByText(/37 unidades mínimas/i);
    fireEvent.click(screen.getByRole('checkbox', { name: /autorizo a cobrança real/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Gerar prompt' }));
    await waitFor(() => expect(pendingApi.getJob).toHaveBeenCalled());
    view.unmount();
    expect(abortSeen).toHaveBeenCalledOnce();
  });

  it('reuses only ambiguous mutation keys and binds generation to project and payload', async () => {
    const retryApi = api();
    retryApi.createProject = vi.fn().mockResolvedValue({ id: 'cm1234567890project' });
    retryApi.generate = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('NETWORK_ERROR'), { code: 'NETWORK_ERROR' }))
      .mockRejectedValueOnce(
        Object.assign(new Error('QUEUE_UNAVAILABLE'), { code: 'QUEUE_UNAVAILABLE' }),
      );
    render(
      <MemoryRouter initialEntries={['/extractions/cm1234567890extract/prompts/new']}>
        <Routes>
          <Route
            path="/extractions/:id/prompts/new"
            element={<PromptWizardPage api={retryApi} />}
          />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Objetivo'), {
      target: { value: 'Criar uma aplicação acessível.' },
    });
    fireEvent.change(screen.getByLabelText('Público-alvo'), {
      target: { value: 'Desenvolvedores' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Revisar' }));
    await screen.findByText(/37 unidades mínimas/i);
    fireEvent.click(screen.getByRole('checkbox', { name: /autorizo a cobrança real/i }));
    const generate = screen.getByRole('button', { name: 'Gerar prompt' });
    fireEvent.click(generate);
    await waitFor(() => expect(retryApi.generate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(generate).toBeEnabled());
    fireEvent.click(generate);
    await waitFor(() => expect(retryApi.generate).toHaveBeenCalledTimes(2));
    expect(vi.mocked(retryApi.generate).mock.calls[1]?.[2]).toBe(
      vi.mocked(retryApi.generate).mock.calls[0]?.[2],
    );
    await waitFor(() => expect(generate).toBeEnabled());
    fireEvent.click(generate);
    await waitFor(() => expect(retryApi.generate).toHaveBeenCalledTimes(3));
    expect(vi.mocked(retryApi.generate).mock.calls[2]?.[2]).not.toBe(
      vi.mocked(retryApi.generate).mock.calls[1]?.[2],
    );
    expect(retryApi.createProject).toHaveBeenCalledOnce();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
