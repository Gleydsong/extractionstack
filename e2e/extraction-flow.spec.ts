import { expect, test, type Page } from '@playwright/test';

const timestamp = '2026-07-15T12:00:00.000Z';
const id = 'cm1234567890abcdef';
const queued = {
  id,
  requestedUrl: 'https://example.com',
  normalizedUrl: 'https://example.com/',
  status: 'QUEUED',
  attempts: 0,
  maxAttempts: 3,
  queuedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const emptySection = {
  title: 'Arquitetura de frontend',
  summary: '1 dimensão identificada.',
  findings: [],
};
const investigation = {
  executiveSummary: {
    systemOverview: 'Site público analisado com evidências técnicas.',
    constructionOverview: 'Tecnologias classificadas sem inferências não sustentadas.',
    mainTechnologies: ['React'],
    limitations: ['Somente acesso público.'],
    overallConfidence: 'highly_probable',
    accessType: 'public_site_devtools',
  },
  technologyTable: [],
  sections: {
    frontend: emptySection,
    designSystem: { ...emptySection, title: 'Design system' },
    backend: { ...emptySection, title: 'Arquitetura de backend' },
    apisCommunication: { ...emptySection, title: 'APIs e comunicação' },
    authenticationSecurity: { ...emptySection, title: 'Autenticação e segurança' },
    cmsContent: { ...emptySection, title: 'CMS e conteúdo' },
    infrastructureDeploy: { ...emptySection, title: 'Infraestrutura e deploy' },
    integrations: { ...emptySection, title: 'Integrações externas' },
    performanceAccessibility: {
      ...emptySection,
      title: 'Performance, SEO e acessibilidade',
    },
  },
  diagramMermaid: 'flowchart TD\nU --> FE',
  estimatedProjectStructure: { disclaimer: 'Proposta de reconstrução.', tree: 'src/' },
  risks: [],
  recommendations: [],
  conclusion: 'Conclusão baseada apenas nas evidências.',
  confidenceMatrix: [
    {
      information: 'Framework frontend',
      result: 'React',
      confidence: 'confirmed',
      justification: 'Evidência direta.',
    },
  ],
  technicalEvidence: {
    analyzedUrls: ['https://example.com'],
    relevantHeaders: {},
    scripts: [],
    stylesheets: [],
    externalDomains: [],
    publicEndpoints: [],
    cookies: [],
    cssVariables: [],
    fonts: [],
    metadata: {},
    manifests: [],
    serviceWorkers: [],
  },
};
const succeeded = {
  ...queued,
  status: 'SUCCEEDED',
  attempts: 1,
  startedAt: timestamp,
  finishedAt: timestamp,
  report: {
    url: queued.requestedUrl,
    finalUrl: queued.normalizedUrl,
    fetchedAt: timestamp,
    durationMs: 125,
    sections: {},
    investigation,
  },
};

async function mockApi(page: Page): Promise<void> {
  const cors = {
    'access-control-allow-origin': 'http://127.0.0.1:5173',
    'access-control-allow-headers': 'authorization,content-type,idempotency-key',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  };
  await page.route(/\/api\/extractions(?:\/.*)?(?:\?.*)?$/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    if (request.method() === 'POST' && url.pathname === '/api/extractions') {
      await route.fulfill({ status: 202, headers: cors, json: queued });
      return;
    }
    if (request.method() === 'GET' && url.pathname === `/api/extractions/${id}`) {
      await route.fulfill({ status: 200, headers: cors, json: succeeded });
      return;
    }
    if (request.method() === 'GET' && url.pathname === '/api/extractions') {
      await route.fulfill({
        status: 200,
        headers: cors,
        json: { items: [succeeded], nextCursor: null },
      });
      return;
    }
    await route.fulfill({
      status: 404,
      headers: cors,
      json: { code: 'NOT_FOUND', message: 'not found' },
    });
  });
}

test('creates an extraction and renders the persisted report', async ({ page }) => {
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) =>
    requestFailures.push(
      `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`,
    ),
  );
  await mockApi(page);
  await page.goto('/');
  expect(pageErrors).toEqual([]);
  await page.getByLabel('URL do site').fill('https://example.com');
  await page.getByRole('button', { name: 'Extrair' }).click();
  await page.waitForTimeout(250);
  expect(requestFailures).toEqual([]);
  await expect(page.getByRole('heading', { name: 'Relatório' })).toBeVisible();
  await expect(page.getByText('Concluída')).toBeVisible();
  await expect(page.getByRole('heading', { name: '1. Resumo executivo' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '20. Matriz final de confiança' })).toBeVisible();
});

test('shows persisted extraction history', async ({ page }) => {
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) =>
    requestFailures.push(
      `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`,
    ),
  );
  await mockApi(page);
  await page.goto('/history');
  expect(pageErrors).toEqual([]);
  await page.waitForTimeout(250);
  expect(requestFailures).toEqual([]);
  await expect(page.getByRole('heading', { name: 'Extrações' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'https://example.com' })).toBeVisible();
});
