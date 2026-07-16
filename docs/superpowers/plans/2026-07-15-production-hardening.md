# ExtractionStack Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a buildable, tested, secure, asynchronous ExtractionStack with durable jobs, persisted reports, operational telemetry, and reproducible local deployment.

**Architecture:** Keep the pnpm monorepo and detector plugin model. Introduce strict shared job contracts, repository-backed lifecycle services, a BullMQ queue, and a separately runnable worker while the API owns HTTP/auth concerns and the web app polls durable jobs. PostgreSQL is the source of truth; Redis coordinates work but does not own user-visible state.

**Tech Stack:** TypeScript 5, React 18, Vite 5, NestJS 10, Zod 3, Prisma 5, PostgreSQL 16, Redis 7, BullMQ, Playwright, Vitest, Testing Library, Supertest, Playwright Test, Pino, prom-client, Docker Compose.

## Global Constraints

- Preserve the current detector interface and isolation between detectors.
- Production code changes follow red-green-refactor; every behavior change starts with a failing test.
- No unsafe Prisma raw-query APIs.
- Never persist raw HTML, cookie values, authorization headers, or target response bodies.
- All public errors are stable, sanitized, and include a request ID.
- All application routes except login and callback require authentication.
- No test depends on a real Auth0 tenant or an arbitrary public website.
- Keep API, worker, and web independently runnable.

---

## File Structure

### New production files

- `packages/shared/src/schemas/jobs.ts` — strict job, pagination, and API response contracts.
- `apps/api/src/common/runtime-env.ts` — centralized environment parsing and production invariants.
- `apps/api/src/common/request-context.middleware.ts` — correlation ID creation and response propagation.
- `apps/api/src/common/security-guardrails.ts` — bounded identifiers and static unsafe-query guard helpers.
- `apps/api/src/extractions/*` — controllers, repository, queue gateway, lifecycle service, ownership rules, and module.
- `apps/api/src/operations/*` — liveness, readiness, metrics, and operational module.
- `apps/worker/src/*` — BullMQ consumer and standalone worker bootstrap.
- `apps/web/src/lib/api-client.ts` — authenticated fetch with runtime response parsing.
- `apps/web/src/features/extractions/*` — asynchronous job hooks, dashboard, history, and detail screens.
- `docker/api.Dockerfile`, `docker/worker.Dockerfile`, `docker/web.Dockerfile` — non-root multi-stage images.
- `docs/operations/runbook.md`, `docs/security/model.md` — operational and security handoff.

### New test files

- `packages/shared/src/schemas/jobs.spec.ts`.
- `apps/api/src/common/runtime-env.spec.ts`.
- `apps/api/src/common/url-safety-v2.spec.ts`.
- `apps/api/src/common/security-guardrails.spec.ts`.
- `apps/api/src/extractions/*.spec.ts`.
- `apps/api/test/extractions.e2e.spec.ts`.
- `apps/worker/src/worker.processor.spec.ts`.
- `apps/web/src/lib/api-client.spec.ts`.
- `apps/web/src/features/extractions/*.spec.tsx`.
- `e2e/extraction-flow.spec.ts`.

---

### Task 1: Restore a deterministic green toolchain

**Files:**

- Modify: `package.json`
- Modify: `apps/api/package.json`
- Modify: `apps/web/package.json`
- Modify: `apps/web/vite.config.ts`
- Modify: `apps/web/src/features/extract/ReportSection.tsx`
- Modify: `apps/api/src/extract/detectors/detectors.spec.ts`
- Create: `apps/web/src/features/extract/ReportSection.spec.tsx`

**Interfaces:**

- Produces: repository scripts `lint`, `typecheck`, `test`, `test:integration`, `test:e2e`, and `verify` with deterministic exit codes.

- [ ] **Step 1: Add a failing component regression test**

```tsx
it.each([
  [{ dimension: 'seo', status: 'skipped', reason: 'no metadata' }, 'no metadata'],
  [{ dimension: 'seo', status: 'error', error: 'detector failed' }, 'detector failed'],
] as const)('renders a terminal non-ok section', (section, expected) => {
  render(<ReportSection section={section} isOpen onToggle={() => undefined} />);
  expect(screen.getByText(expected)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused test and typecheck to verify the current failure**

Run: `pnpm --filter @extractionstack/web test -- ReportSection.spec.tsx && pnpm --filter @extractionstack/web typecheck`

Expected before implementation: the test setup or compile fails at the invalid `reason ?? error` union access.

- [ ] **Step 3: Narrow the discriminated union explicitly**

```tsx
function terminalMessage(section: Exclude<DetectorResult, { status: 'ok' }>): string {
  return section.status === 'skipped' ? section.reason : section.error;
}
```

Use `terminalMessage(section)` only inside the non-`ok` render branch.

- [ ] **Step 4: Repair fixture completeness and test configuration**

Add `cookies: []` to the v1 detector fixture. Configure web Vitest with `environment: 'jsdom'`, a setup file importing `@testing-library/jest-dom/vitest`, and `passWithNoTests: false`. Install and configure ESLint at the root so all workspaces resolve the same executable.

- [ ] **Step 5: Verify the baseline**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`

Expected: all commands exit 0 with real web tests executed.

---

### Task 2: Add strict contracts and environment guardrails

**Files:**

- Create: `packages/shared/src/schemas/jobs.ts`
- Create: `packages/shared/src/schemas/jobs.spec.ts`
- Modify: `packages/shared/src/schemas/common.ts`
- Modify: `packages/shared/src/schemas/extract.ts`
- Modify: `packages/shared/src/schemas/index.ts`
- Create: `apps/api/src/common/runtime-env.ts`
- Create: `apps/api/src/common/runtime-env.spec.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `.env.example`

**Interfaces:**

- Produces: `CreateExtractionSchema`, `ExtractionJobSchema`, `ExtractionListQuerySchema`, `ExtractionListResponseSchema`, `RuntimeEnvSchema`, and `loadRuntimeEnv()`.

- [ ] **Step 1: Write strict contract tests**

```ts
it('rejects unknown job fields and oversized idempotency keys', () => {
  expect(
    CreateExtractionSchema.safeParse({ url: 'https://example.com', admin: true }).success,
  ).toBe(false);
  expect(IdempotencyKeySchema.safeParse('x'.repeat(129)).success).toBe(false);
});

it('rejects arbitrary sort expressions', () => {
  expect(ExtractionListQuerySchema.safeParse({ sort: 'createdAt; DROP TABLE User' }).success).toBe(
    false,
  );
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @extractionstack/shared test`

Expected: FAIL because the schemas do not exist.

- [ ] **Step 3: Implement strict schemas**

Use `.strict()`, URL maximum 2048, idempotency key pattern `/^[A-Za-z0-9._:-]{8,128}$/`, cursor maximum 256, page limit `1..100`, and explicit status/sort enums. Extend `ErrorResponseSchema` with `requestId` and the approved operational codes.

- [ ] **Step 4: Write environment invariant tests**

```ts
it('rejects production dev auth and wildcard cors', () => {
  expect(() =>
    loadRuntimeEnv({ NODE_ENV: 'production', AUTH_DEV_MODE: 'true', CORS_ORIGIN: '*' }),
  ).toThrow();
});
```

- [ ] **Step 5: Implement centralized environment parsing**

Parse ports, URLs, timeouts, concurrency, Auth0, Redis, database, CORS, request limits, and metrics token once. `main.ts` consumes the parsed object and enables shutdown hooks. Production rejects placeholder Auth0 values and development bypass flags.

- [ ] **Step 6: Verify contracts and environment**

Run: `pnpm --filter @extractionstack/shared test && pnpm --filter @extractionstack/api test -- runtime-env.spec.ts`

Expected: PASS.

---

### Task 3: Harden URL safety, error handling, and security invariants

**Files:**

- Modify: `apps/api/src/common/url-safety.ts`
- Create: `apps/api/src/common/url-safety-v2.spec.ts`
- Create: `apps/api/src/common/security-guardrails.ts`
- Create: `apps/api/src/common/security-guardrails.spec.ts`
- Modify: `apps/api/src/common/http-exception.filter.ts`
- Modify: `apps/api/src/common/extract-errors.ts`
- Modify: `apps/api/src/extract/crawler/playwright-crawler.ts`
- Create: `apps/api/src/extract/detectors/evidence-contract.spec.ts`
- Modify: `apps/api/src/main.ts`

**Interfaces:**

- Produces: `UrlSafetyPolicy`, `assertSafeTargetUrl(url, resolver?, policy?)`, `assertSafeRedirectChain()`, and sanitized public errors.

- [ ] **Step 1: Add failing SSRF table tests**

```ts
it.each([
  'http://100.64.0.1',
  'http://192.0.2.1',
  'http://[::ffff:127.0.0.1]',
  'http://user:pass@example.com',
  'http://example.com:2375',
])('rejects unsafe target %s', async (url) => {
  await expect(assertSafeTargetUrl(url, publicResolver)).rejects.toBeInstanceOf(UrlNotAllowedError);
});
```

Add mixed DNS-answer, redirect-to-private, excessive redirect, oversized HTML, and excessive network-entry cases.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @extractionstack/api test -- url-safety-v2.spec.ts`

Expected: the new blocked ranges and policies fail.

- [ ] **Step 3: Implement IP classification and redirect enforcement**

Use `ipaddr.js` parsing, reject all non-unicast/public ranges, normalize mapped IPv6, reject credentials and disallowed ports, inject a resolver for deterministic tests, and route every Playwright request through the same pre-dispatch safety check. Bound redirects, HTML bytes, response count, and string metadata.

- [ ] **Step 4: Add SQL-injection and unsafe-query static guards**

```ts
it('contains no unsafe Prisma raw query API in production sources', () => {
  expect(findUnsafeRawQueries(apiSourceFiles)).toEqual([]);
});

it.each(["' OR 1=1 --", "x'; DROP TABLE User; --", '${7*7}', '__proto__'])(
  'treats malicious input as data',
  (value) => {
    expect(() => assertSafeIdentifier(value)).toThrow();
  },
);
```

- [ ] **Step 5: Sanitize errors and constrain HTTP input**

Configure Express JSON limit `16kb`, Helmet CSP, safe request IDs, and a filter that maps known errors to codes while logging internal causes without returning stack traces or raw exception messages.

- [ ] **Step 6: Enforce the detector evidence contract**

Add a registry-driven test that executes every detector against its positive fixture and requires every non-empty `ok` detection to expose at least one top-level evidence item with a valid source, bounded snippet, and confidence. Fix detectors incrementally so the report never claims a positive detection without explaining why.

- [ ] **Step 7: Verify security and evidence tests**

Run: `pnpm --filter @extractionstack/api test -- url-safety-v2.spec.ts security-guardrails.spec.ts extract-errors.spec.ts evidence-contract.spec.ts`

Expected: PASS.

---

### Task 4: Add durable persistence and ownership-aware lifecycle services

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260715_jobs_reports/migration.sql`
- Modify: `apps/api/src/prisma/prisma.module.ts`
- Create: `apps/api/src/extractions/extractions.repository.ts`
- Create: `apps/api/src/extractions/extractions.repository.spec.ts`
- Create: `apps/api/src/extractions/extractions.service.ts`
- Create: `apps/api/src/extractions/extractions.service.spec.ts`
- Create: `apps/api/src/extractions/extractions.module.ts`

**Interfaces:**

- Produces: `createJob()`, `findOwnedJob()`, `listOwnedJobs()`, `requestCancellation()`, `markRunning()`, `completeJob()`, and `failJob()`.

- [ ] **Step 1: Write lifecycle and ownership tests against repository ports**

```ts
it('returns an existing job for the same owner and idempotency key', async () => {
  const first = await service.create(actor, command);
  const second = await service.create(actor, command);
  expect(second.id).toBe(first.id);
  expect(queue.enqueue).toHaveBeenCalledTimes(1);
});

it('does not reveal another user job', async () => {
  await expect(service.get(otherActor, job.id)).rejects.toMatchObject({ status: 404 });
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @extractionstack/api test -- extractions.service.spec.ts`

Expected: FAIL because lifecycle service does not exist.

- [ ] **Step 3: Add Prisma enums and models**

Add `UserRole`, `ExtractionStatus`, `User`, `ExtractionJob`, `ExtractionReport`, and `AuditEvent` with the indexes and uniqueness rules from the approved design. Use `Json` only for bounded report sections and audit metadata.

- [ ] **Step 4: Implement repository and service transactions**

All lookups use Prisma query objects. Job creation, audit creation, and idempotency resolution are transactional. Ownership predicates are part of database queries. State transitions use conditional `updateMany` operations so concurrent workers cannot move terminal jobs backwards.

- [ ] **Step 5: Verify generated client, migration, and services**

Run: `pnpm prisma:generate && pnpm --filter @extractionstack/api test -- extractions.repository.spec.ts extractions.service.spec.ts && pnpm --filter @extractionstack/api typecheck`

Expected: PASS.

---

### Task 5: Add BullMQ and a separately runnable worker

**Files:**

- Modify: `pnpm-workspace.yaml`
- Create: `apps/worker/package.json`
- Create: `apps/worker/tsconfig.json`
- Create: `apps/worker/src/main.ts`
- Create: `apps/worker/src/worker.module.ts`
- Create: `apps/worker/src/worker.processor.ts`
- Create: `apps/worker/src/worker.processor.spec.ts`
- Create: `apps/api/src/extractions/extraction-queue.ts`
- Create: `apps/api/src/extractions/extraction-queue.spec.ts`
- Modify: `apps/api/src/extract/extract.service.ts`
- Modify: `apps/api/src/extract/crawler/playwright-crawler.ts`

**Interfaces:**

- Produces: queue name `extractions-v1`, payload `{ jobId: string }`, `ExtractionQueue.enqueue/cancel`, and `WorkerProcessor.process(job)`.

- [ ] **Step 1: Write queue contract and processor tests**

```ts
it('persists success only after a validated report', async () => {
  extractor.extract.mockResolvedValue(validReport);
  await processor.process(job);
  expect(repo.completeJob).toHaveBeenCalledWith(job.id, validReport);
});

it('sanitizes worker failures', async () => {
  extractor.extract.mockRejectedValue(new Error('password=secret /private/path'));
  await expect(processor.process(job)).rejects.toThrow();
  expect(repo.failJob).toHaveBeenCalledWith(job.id, 'INTERNAL', 'extraction failed');
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @extractionstack/worker test`

Expected: FAIL because the worker package and processor do not exist.

- [ ] **Step 3: Implement BullMQ gateway**

Use deterministic job IDs derived from database IDs, three attempts, exponential backoff, removal policies, and queue-event logging. Redis connection options come only from validated environment configuration.

- [ ] **Step 4: Implement worker lifecycle**

The worker marks jobs running, checks cancellation, executes extraction, validates `ExtractionReportSchema`, persists success/failure, closes browser contexts in `finally`, and handles SIGTERM by pausing the queue before closing dependencies.

- [ ] **Step 5: Verify worker and queue**

Run: `pnpm --filter @extractionstack/worker test && pnpm --filter @extractionstack/worker typecheck && pnpm --filter @extractionstack/worker build`

Expected: PASS.

---

### Task 6: Replace synchronous API routes with authenticated job APIs

**Files:**

- Delete: `apps/api/src/extract/extract.controller.ts`
- Create: `apps/api/src/extractions/extractions.controller.ts`
- Create: `apps/api/src/extractions/extractions.controller.spec.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/test/vitest.e2e.config.ts`
- Create: `apps/api/test/extractions.e2e.spec.ts`

**Interfaces:**

- Produces: `POST/GET /api/extractions`, `GET /api/extractions/:id`, and `POST /api/extractions/:id/cancel`.

- [ ] **Step 1: Write API E2E contract tests**

```ts
it('creates a durable job and returns 202', async () => {
  await request(app.getHttpServer())
    .post('/api/extractions')
    .set('Idempotency-Key', 'test-create-0001')
    .send({ url: 'https://example.com' })
    .expect(202)
    .expect(({ body }) => expect(body.status).toBe('QUEUED'));
});

it.each(["' OR 1=1 --", "x'; DROP TABLE User; --"])(
  'does not broaden an ID lookup: %s',
  async (id) => {
    await request(app.getHttpServer())
      .get(`/api/extractions/${encodeURIComponent(id)}`)
      .expect(400);
  },
);
```

Add ownership, admin, unknown-key, malformed cursor, duplicate idempotency, cancellation, error sanitization, 16 KiB payload, and rate-limit cases.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @extractionstack/api test:e2e`

Expected: FAIL because asynchronous routes do not exist.

- [ ] **Step 3: Implement thin controllers and auth identity sync**

Controllers validate body, params, query, and idempotency header with Zod pipes, then call lifecycle services. The verified Auth0 subject is upserted before job access. No controller imports Prisma or BullMQ.

- [ ] **Step 4: Remove the synchronous public endpoint**

Keep the extractor service injectable only by the worker. Remove `ExtractController` from `ExtractModule` and import `ExtractionsModule` into `AppModule`.

- [ ] **Step 5: Verify unit and API E2E suites**

Run: `pnpm --filter @extractionstack/api test && pnpm --filter @extractionstack/api test:e2e`

Expected: PASS.

---

### Task 7: Migrate the frontend to asynchronous jobs and add browser E2E

**Files:**

- Create: `apps/web/src/lib/api-client.ts`
- Create: `apps/web/src/lib/api-client.spec.ts`
- Create: `apps/web/src/features/extractions/useExtractionJob.ts`
- Create: `apps/web/src/features/extractions/useExtractionJob.spec.tsx`
- Create: `apps/web/src/features/extractions/DashboardPage.tsx`
- Create: `apps/web/src/features/extractions/HistoryPage.tsx`
- Create: `apps/web/src/features/extractions/ExtractionPage.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/index.css`
- Create: `playwright.config.ts`
- Create: `e2e/extraction-flow.spec.ts`

**Interfaces:**

- Produces: parsed `apiRequest<T>()`, `useExtractionJob()`, protected dashboard/history/detail routes, and browser E2E scripts.

- [ ] **Step 1: Write API parsing and polling tests**

```ts
it('rejects a successful response that violates the shared schema', async () => {
  server.use(http.get('/api/extractions/job-1', () => HttpResponse.json({ status: 'MAGIC' })));
  await expect(client.getJob('job-1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});

it('stops polling at a terminal state', async () => {
  renderHook(() => useExtractionJob('job-1'), { wrapper });
  await waitFor(() => expect(screenState.current.job?.status).toBe('SUCCEEDED'));
  expect(fetchJob).toHaveBeenCalledTimes(3);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @extractionstack/web test -- api-client.spec.ts useExtractionJob.spec.tsx`

Expected: FAIL because client and hook do not exist.

- [ ] **Step 3: Implement runtime-parsed client and bounded polling**

All successful responses use shared schemas. Poll delays progress from 500 ms to a maximum of 5 s, stop on terminal states/unmount, and expose cancellation without updating unmounted state.

- [ ] **Step 4: Implement protected application routes and states**

Wrap `/`, `/history`, and `/extractions/:id` in `RequireAuth`. Render explicit queued, running, succeeded, failed, cancelling, cancelled, empty-history, network-error, and invalid-response states. Preserve report evidence as text.

- [ ] **Step 5: Add deterministic browser E2E**

Run the web app in development auth mode and route API requests to deterministic fixtures. Cover submission, progress, report rendering, cancellation, history navigation, and login redirect without a real Auth0 tenant.

- [ ] **Step 6: Verify frontend**

Run: `pnpm --filter @extractionstack/web test && pnpm --filter @extractionstack/web typecheck && pnpm test:e2e`

Expected: PASS.

---

### Task 8: Add operational telemetry, containers, and runbooks

**Files:**

- Create: `apps/api/src/common/request-context.middleware.ts`
- Create: `apps/api/src/common/request-context.middleware.spec.ts`
- Create: `apps/api/src/operations/metrics.service.ts`
- Create: `apps/api/src/operations/operations.controller.ts`
- Create: `apps/api/src/operations/operations.controller.spec.ts`
- Create: `apps/api/src/operations/operations.module.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/worker/src/main.ts`
- Modify: `docker-compose.yml`
- Create: `docker/api.Dockerfile`
- Create: `docker/worker.Dockerfile`
- Create: `docker/web.Dockerfile`
- Create: `docs/operations/runbook.md`
- Create: `docs/security/model.md`
- Modify: `README.md`

**Interfaces:**

- Produces: `/health/live`, `/health/ready`, `/metrics`, request ID propagation, redacted JSON logs, and five-service Docker Compose deployment.

- [ ] **Step 1: Write operational endpoint and request-ID tests**

```ts
it('replaces an unsafe request id and returns the generated id', async () => {
  const response = await request(app).get('/health/live').set('X-Request-Id', '\nforged');
  expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
});

it('keeps liveness healthy when dependencies are down', async () => {
  dependencies.postgres.mockRejectedValue(new Error('down'));
  await request(app).get('/health/live').expect(200);
  await request(app).get('/health/ready').expect(503);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @extractionstack/api test -- request-context.middleware.spec.ts operations.controller.spec.ts`

Expected: FAIL because middleware and operational endpoints do not exist.

- [ ] **Step 3: Implement logs, metrics, health, and graceful shutdown**

Use Pino redaction for authorization/cookie/token/password paths. Use prom-client metrics with bounded labels. Readiness checks PostgreSQL and Redis; liveness has no dependency check. API and worker register SIGTERM-safe shutdown hooks.

- [ ] **Step 4: Implement container deployment**

Compose starts PostgreSQL 16, Redis 7, API, worker, and web with health-based dependencies, explicit resource-friendly defaults, non-root application users, and named state volumes. Images use pnpm-frozen multi-stage builds and production commands.

- [ ] **Step 5: Write operational and security documentation**

The runbook documents bootstrap, migrations, health diagnosis, queue inspection, failed-job recovery, shutdown, backup/restore, alerts, and rollback. The security model documents trust boundaries, SSRF, SQL injection, XSS, auth, secrets, rate limits, logging redaction, residual risks, and validation commands.

- [ ] **Step 6: Run complete verification**

Run: `pnpm verify`

Expected: lint, typecheck, unit, integration, API E2E, browser E2E, and build all exit 0.

Run: `docker compose config`

Expected: exit 0 with all five services resolved.

Run: `git diff --check`

Expected: exit 0 with no whitespace errors.

- [ ] **Step 7: Review requirements against the approved specification**

Confirm every success criterion in `docs/superpowers/specs/2026-07-15-production-hardening-design.md` has current command output or a focused automated test. Record any environment-dependent verification limit explicitly in the final handoff.
