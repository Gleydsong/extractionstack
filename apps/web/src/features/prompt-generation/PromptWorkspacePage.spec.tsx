import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { PromptWorkspacePage } from './PromptWorkspacePage';
import { PromptClientError, type PromptApi } from './usePromptApi';

const now = '2026-07-17T12:00:00.000Z';
const version = {
  id: 'cm1234567890version',
  projectId: 'cm1234567890project',
  sequence: 1,
  sourceVersionId: null,
  kind: 'UNIVERSAL',
  destination: 'universal',
  content: 'Prompt universal em linguagem natural.',
  summary: 'Prompt inicial.',
  provider: 'OPENAI',
  model: 'model-test',
  createdAt: now,
} as const;

function api(): PromptApi {
  return {
    getProject: vi.fn().mockResolvedValue({
      id: version.projectId,
      extractionId: 'cm1234567890extract',
      title: 'Aplicação acessível',
      category: 'application',
      language: 'pt-BR',
      wizardInput: {
        extractionId: 'cm1234567890extract',
        category: 'application',
        objective: 'Criar aplicação acessível.',
        audience: 'Pessoas',
        technologies: [],
        exclusions: [],
        requirements: [],
        language: 'pt-BR',
        detail: 'balanced',
        destination: 'universal',
        freeInstructions: '',
      },
      currentVersionId: version.id,
      state: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    }),
    listVersions: vi
      .fn()
      .mockResolvedValue({ items: [{ ...version, content: undefined }], nextCursor: null }),
    getVersion: vi.fn().mockResolvedValue(version),
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
    listConnections: vi.fn().mockResolvedValue([
      {
        id: 'cm1234567890connection',
        provider: 'OPENAI',
        displayLabel: 'OpenAI principal',
        credentialMode: 'API_KEY',
        state: 'ACTIVE',
        maskedCredential: '…test',
        scopes: [],
        expiresAt: null,
        validatedAt: now,
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ]),
    estimateVersionCost: vi.fn().mockResolvedValue({
      provider: 'OPENAI',
      model: 'model-test',
      sourceVersionId: version.id,
      operation: 'ADAPT',
      reportSections: ['technologies', 'structure', 'evidence', 'limitations', 'confidence'],
      retentionNotice: 'Prompt, versão e prévia permanecem no histórico do projeto.',
      maximumInputTokens: 2400,
      maximumOutputTokens: 1000,
      maximumCostMinor: '37',
      pricingVersion: 'pricing-2026-07',
      quotedAt: now,
    }),
    editVersion: vi.fn().mockResolvedValue({
      ...version,
      id: 'cm2234567890version',
      sequence: 2,
      sourceVersionId: version.id,
      content: 'Prompt editado.',
    }),
    adapt: vi.fn().mockResolvedValue({
      id: 'cm1234567890adaptjob',
      projectId: version.projectId,
      operation: 'ADAPT',
      provider: 'OPENAI',
      model: 'model-test',
      credentialMode: 'API_KEY',
      status: 'QUEUED',
      attempts: 0,
      maxAttempts: 3,
      sourcePromptVersionId: version.id,
      resultPromptVersionId: null,
      message: 'Aguardando.',
      queuedAt: now,
      startedAt: null,
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
    }),
    preview: vi.fn().mockResolvedValue({
      id: 'cm1234567890previewjob',
      projectId: version.projectId,
      operation: 'PREVIEW',
      provider: 'OPENAI',
      model: 'model-test',
      credentialMode: 'API_KEY',
      status: 'QUEUED',
      attempts: 0,
      maxAttempts: 3,
      sourcePromptVersionId: version.id,
      resultPromptVersionId: null,
      message: 'Aguardando.',
      queuedAt: now,
      startedAt: null,
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
    }),
    getJob: vi.fn().mockImplementation(async (id: string) => ({
      id,
      projectId: version.projectId,
      operation: id.includes('preview') ? 'PREVIEW' : 'ADAPT',
      provider: 'OPENAI',
      model: 'model-test',
      credentialMode: 'API_KEY',
      status: 'SUCCEEDED',
      attempts: 1,
      maxAttempts: 3,
      sourcePromptVersionId: version.id,
      resultPromptVersionId: id.includes('preview') ? null : version.id,
      message: 'Concluído.',
      queuedAt: now,
      startedAt: now,
      finishedAt: now,
      createdAt: now,
      updatedAt: now,
    })),
    getPreview: vi.fn().mockResolvedValue({
      id: 'cm1234567890preview',
      promptVersionId: version.id,
      status: 'SUCCEEDED',
      content: 'Prévia somente em texto.',
      summary: 'Resumo seguro.',
      provider: 'OPENAI',
      model: 'model-test',
      finishReason: 'done',
      latencyMs: 10,
      createdAt: now,
      completedAt: now,
    }),
    cancel: vi.fn(),
  } as unknown as PromptApi;
}

describe('PromptWorkspacePage', () => {
  it('renders natural content, copies only content, and saves an immutable version', async () => {
    const client = api();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(
      <MemoryRouter initialEntries={['/prompt-projects/cm1234567890project']}>
        <Routes>
          <Route path="/prompt-projects/:id" element={<PromptWorkspacePage api={client} />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByDisplayValue('Prompt universal em linguagem natural.')).toBeVisible();
    expect(document.querySelector('pre[data-raw-json]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copiar' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('Prompt universal em linguagem natural.'),
    );
    fireEvent.change(screen.getByLabelText('Prompt em linguagem natural'), {
      target: { value: 'Prompt editado.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar como nova versão' }));
    await waitFor(() =>
      expect(client.editVersion).toHaveBeenCalledWith(
        version.id,
        { content: 'Prompt editado.' },
        expect.stringMatching(/^prompt-edit:/),
      ),
    );
    expect(await screen.findByText(/versão 2 criada/i)).toBeVisible();
  });

  it('adapts and previews the selected immutable version without rendering JSON', async () => {
    const client = api();
    render(
      <MemoryRouter initialEntries={['/prompt-projects/cm1234567890project']}>
        <Routes>
          <Route path="/prompt-projects/:id" element={<PromptWorkspacePage api={client} />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByDisplayValue(version.content);
    fireEvent.change(screen.getByLabelText('Conexão'), {
      target: { value: 'cm1234567890connection' },
    });
    const adapt = screen.getByRole('button', { name: 'Adaptar' });
    await waitFor(() => expect(adapt).toBeEnabled());
    fireEvent.click(adapt);
    await waitFor(() =>
      expect(client.adapt).toHaveBeenCalledWith(
        version.id,
        expect.objectContaining({ destination: 'codex', connectionId: 'cm1234567890connection' }),
        expect.stringMatching(/^prompt-adapt:/),
      ),
    );
    fireEvent.change(screen.getByLabelText('Operação cotada'), { target: { value: 'PREVIEW' } });
    const previewButton = screen.getByRole('button', { name: 'Gerar prévia' });
    await waitFor(() => expect(previewButton).toBeEnabled());
    fireEvent.click(previewButton);
    expect(await screen.findByText('Prévia somente em texto.')).toBeVisible();
    expect(document.body.textContent).not.toContain('rawProviderPayload');
  });

  it('exports only the natural-language content and never writes browser storage', async () => {
    const createObjectURL = vi.fn().mockReturnValue('blob:prompt');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    render(
      <MemoryRouter initialEntries={['/prompt-projects/cm1234567890project']}>
        <Routes>
          <Route path="/prompt-projects/:id" element={<PromptWorkspacePage api={api()} />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByDisplayValue(version.content);
    fireEvent.click(screen.getByRole('button', { name: 'Exportar Markdown' }));
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob ? await readBlob(blob) : '').toBe(version.content);
    expect(anchorClick).toHaveBeenCalledOnce();
    expect(storageWrite).not.toHaveBeenCalled();
    anchorClick.mockRestore();
  });

  it('loads cursor pagination without replacing immutable history', async () => {
    const client = api();
    vi.mocked(client.listVersions)
      .mockResolvedValueOnce({
        items: [{ ...version, content: undefined }],
        nextCursor: 'cm2234567890cursor',
      } as never)
      .mockResolvedValueOnce({
        items: [{ ...version, id: 'cm2234567890version', sequence: 2, content: undefined }],
        nextCursor: null,
      } as never);
    render(
      <MemoryRouter initialEntries={['/prompt-projects/cm1234567890project']}>
        <Routes>
          <Route path="/prompt-projects/:id" element={<PromptWorkspacePage api={client} />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText(/Versão 1/);
    fireEvent.click(screen.getByRole('button', { name: /carregar mais versões/i }));
    expect(await screen.findByText(/Versão 2/)).toBeVisible();
    expect(client.listVersions).toHaveBeenLastCalledWith(
      version.projectId,
      'cm2234567890cursor',
      expect.any(AbortSignal),
    );
  });

  it('rotates a terminal failed operation key and blocks another paid job while active', async () => {
    const client = api();
    const succeeded = await client.getJob('cm1234567890adaptjob');
    const pending = deferred<Awaited<ReturnType<PromptApi['getJob']>>>();
    vi.mocked(client.getJob).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(succeeded);
    render(
      <MemoryRouter initialEntries={['/prompt-projects/cm1234567890project']}>
        <Routes>
          <Route path="/prompt-projects/:id" element={<PromptWorkspacePage api={client} />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByDisplayValue(version.content);
    fireEvent.change(screen.getByLabelText('Conexão'), {
      target: { value: 'cm1234567890connection' },
    });
    const adapt = screen.getByRole('button', { name: 'Adaptar' });
    await waitFor(() => expect(adapt).toBeEnabled());
    fireEvent.click(adapt);
    await waitFor(() => expect(adapt).toBeDisabled());
    pending.resolve({
      ...succeeded,
      status: 'FAILED',
      errorCode: 'PROVIDER_FAILED',
      retryable: true,
      message: 'Falhou.',
    } as never);
    await waitFor(() => expect(adapt).toBeEnabled());
    fireEvent.click(adapt);
    await waitFor(() => expect(client.adapt).toHaveBeenCalledTimes(2));
    expect(vi.mocked(client.adapt).mock.calls[1]?.[2]).not.toBe(
      vi.mocked(client.adapt).mock.calls[0]?.[2],
    );
  });

  it('resumes reconciliation after a succeeded job without starting another paid preview', async () => {
    const client = api();
    vi.mocked(client.getPreview)
      .mockRejectedValueOnce(new PromptClientError('NETWORK_ERROR'))
      .mockResolvedValueOnce({
        id: 'cm1234567890preview',
        promptVersionId: version.id,
        status: 'SUCCEEDED',
        content: 'Prévia reconciliada em linguagem natural.',
        summary: 'Resultado recuperado sem nova cobrança.',
        provider: 'OPENAI',
        model: 'model-test',
        finishReason: 'done',
        latencyMs: 10,
        createdAt: now,
        completedAt: now,
      });
    render(
      <MemoryRouter initialEntries={['/prompt-projects/cm1234567890project']}>
        <Routes>
          <Route path="/prompt-projects/:id" element={<PromptWorkspacePage api={client} />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByDisplayValue(version.content);
    fireEvent.change(screen.getByLabelText('Conexão'), {
      target: { value: 'cm1234567890connection' },
    });
    fireEvent.change(screen.getByLabelText('Operação cotada'), { target: { value: 'PREVIEW' } });
    const previewButton = screen.getByRole('button', { name: 'Gerar prévia' });
    await waitFor(() => expect(previewButton).toBeEnabled());
    fireEvent.click(previewButton);

    const resume = await screen.findByRole('button', { name: 'Retomar resultado concluído' });
    expect(client.preview).toHaveBeenCalledTimes(1);
    expect(previewButton).toBeDisabled();
    fireEvent.click(resume);

    expect(await screen.findByText('Prévia reconciliada em linguagem natural.')).toBeVisible();
    expect(client.preview).toHaveBeenCalledTimes(1);
    expect(client.adapt).not.toHaveBeenCalled();
    expect(client.getJob).toHaveBeenCalledWith('cm1234567890previewjob', expect.any(AbortSignal));
    expect(client.getPreview).toHaveBeenCalledTimes(2);
  });

  it('labels interrupted polling as ongoing tracking while the job is not terminal', async () => {
    const client = api();
    vi.mocked(client.getJob).mockRejectedValue(new PromptClientError('NETWORK_ERROR'));
    render(
      <MemoryRouter initialEntries={['/prompt-projects/cm1234567890project']}>
        <Routes>
          <Route path="/prompt-projects/:id" element={<PromptWorkspacePage api={client} />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByDisplayValue(version.content);
    fireEvent.change(screen.getByLabelText('Conexão'), {
      target: { value: 'cm1234567890connection' },
    });
    fireEvent.change(screen.getByLabelText('Operação cotada'), { target: { value: 'PREVIEW' } });
    const previewButton = screen.getByRole('button', { name: 'Gerar prévia' });
    await waitFor(() => expect(previewButton).toBeEnabled());
    fireEvent.click(previewButton);

    expect(await screen.findByRole('button', { name: 'Retomar acompanhamento' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retomar resultado concluído' })).toBeNull();
    expect(client.preview).toHaveBeenCalledTimes(1);
  });

  it('rotates a definitive mutation error key for the same fingerprint', async () => {
    const client = api();
    client.adapt = vi
      .fn()
      .mockRejectedValueOnce(new PromptClientError('QUEUE_UNAVAILABLE'))
      .mockRejectedValueOnce(new PromptClientError('QUEUE_UNAVAILABLE'));
    render(
      <MemoryRouter initialEntries={['/prompt-projects/cm1234567890project']}>
        <Routes>
          <Route path="/prompt-projects/:id" element={<PromptWorkspacePage api={client} />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByDisplayValue(version.content);
    fireEvent.change(screen.getByLabelText('Conexão'), {
      target: { value: 'cm1234567890connection' },
    });
    const adapt = screen.getByRole('button', { name: 'Adaptar' });
    await waitFor(() => expect(adapt).toBeEnabled());
    fireEvent.click(adapt);
    await waitFor(() => expect(adapt).toBeEnabled());
    fireEvent.click(adapt);
    await waitFor(() => expect(client.adapt).toHaveBeenCalledTimes(2));
    expect(vi.mocked(client.adapt).mock.calls[1]?.[2]).not.toBe(
      vi.mocked(client.adapt).mock.calls[0]?.[2],
    );
  });

  it('shows an exact version quote and blocks consent until it is current', async () => {
    const client = api();
    render(
      <MemoryRouter initialEntries={['/prompt-projects/cm1234567890project']}>
        <Routes>
          <Route path="/prompt-projects/:id" element={<PromptWorkspacePage api={client} />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByDisplayValue(version.content);
    fireEvent.change(screen.getByLabelText('Modo'), { target: { value: 'PLATFORM_CREDITS' } });
    expect(await screen.findByText(/^Cotação da versão 1 para ADAPT/i)).toBeVisible();
    expect(screen.getByText(/entrada máxima: 2\.400 tokens/i)).toBeVisible();
    expect(screen.getByText(/saída máxima: 1\.000 tokens/i)).toBeVisible();
    expect(screen.getByText(/pricing-2026-07/i)).toBeVisible();
    expect(screen.getByText(/tecnologias.*evidências/i)).toBeVisible();
    expect(screen.getByText(/permanecem no histórico/i)).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /autorizo cobrança real/i })).toBeRequired();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result ?? '')));
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsText(blob);
  });
}
