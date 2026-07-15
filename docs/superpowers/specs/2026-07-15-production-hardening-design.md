# ExtractionStack Production Hardening Design

**Date:** 2026-07-15
**Status:** Proposed; architecture approved, written specification awaiting review
**Scope:** One extensive delivery covering application stability, asynchronous extraction, persistence, security, testing, observability, and local deployment

## 1. Objective

Evolve ExtractionStack from a synchronous technical prototype into an operationally credible application that can accept authenticated extraction requests, process them outside the HTTP request lifecycle, persist reports, expose job history, and provide enough security and observability for a controlled production deployment.

The delivery must preserve the current detector plugin model and shared Zod contracts. It must not introduce independent domain microservices. The system remains a modular monorepo with separately deployable API, worker, and web processes.

## 2. Success Criteria

The delivery is successful when:

1. `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` complete successfully.
2. The API can create, retrieve, list, and cancel extraction jobs.
3. A BullMQ worker can crawl a submitted public URL, run all detectors, and persist the final report.
4. Jobs survive API restarts because job state is stored in Redis and PostgreSQL.
5. Users can access only their own jobs and reports; administrators can access all jobs.
6. Public and private network targets are rejected before navigation and after every redirect.
7. Input validation, persistence, and error responses are covered by automated injection and abuse tests.
8. API integration tests exercise authentication, authorization, ownership, validation, persistence, and job submission.
9. Browser E2E tests cover login in development mode, extraction submission, progress, success, failure, and history.
10. Liveness, readiness, metrics, structured logs, correlation IDs, and graceful shutdown are implemented and documented.
11. Docker Compose starts PostgreSQL, Redis, API, worker, and web with health checks and non-root application containers.

## 3. Architecture

### 3.1 Deployment units

The monorepo will contain three application processes:

- `apps/web`: React/Vite user interface.
- `apps/api`: NestJS HTTP API responsible for authentication, authorization, validation, job lifecycle, report reads, health, and metrics.
- `apps/worker`: NestJS standalone process responsible for consuming BullMQ jobs, running Playwright, executing detectors, and persisting results.

The API and worker share extraction application code from `apps/api/src/extract` during this delivery. The crawler and detectors remain framework-light and do not call repositories directly. A future package extraction is only justified if independent versioning becomes necessary.

### 3.2 Infrastructure

- PostgreSQL 16 stores users, extraction jobs, reports, and audit events.
- Redis 7 stores BullMQ queues, locks, attempts, and short-lived coordination data.
- BullMQ provides durable jobs, bounded retries, exponential backoff, cancellation, and concurrency control.
- Playwright Chromium runs only in the worker.

### 3.3 Request flow

1. The authenticated client sends `POST /api/extractions` with a URL and an `Idempotency-Key` header.
2. Zod validates the body and header.
3. The URL safety service normalizes the URL, permits only HTTP/HTTPS, resolves every address, and rejects private, loopback, link-local, multicast, reserved, and metadata targets.
4. The API upserts the Auth0 identity, creates an `ExtractionJob` transactionally, and enqueues its ID.
5. The API returns `202 Accepted` with the job representation.
6. The worker marks the job `RUNNING`, crawls with a fresh browser context, validates every redirect target, runs detectors, and persists an `ExtractionReport`.
7. The worker marks the job `SUCCEEDED` or stores a sanitized failure code and marks it `FAILED`.
8. The web application polls `GET /api/extractions/:id` with bounded backoff until the job reaches a terminal state.

## 4. Domain and Persistence Model

### 4.1 User

- `id`: CUID primary key.
- `auth0Sub`: unique external identity.
- `email`, `name`: optional profile snapshot.
- `role`: enum `USER | ADMIN`.
- timestamps.

The role used for authorization comes from the verified Auth0 token. The database role is an auditable mirror and never upgrades a token's privileges.

### 4.2 ExtractionJob

- `id`: CUID primary key.
- `ownerId`: required user foreign key.
- `requestedUrl`, `normalizedUrl`: bounded strings.
- `status`: `QUEUED | RUNNING | SUCCEEDED | FAILED | CANCEL_REQUESTED | CANCELLED`.
- `idempotencyKey`: required, unique per owner.
- `attempts`, `maxAttempts`.
- `errorCode`, `errorMessage`: sanitized and bounded.
- `queuedAt`, `startedAt`, `finishedAt`, timestamps.

Indexes cover `(ownerId, createdAt)`, `status`, and the owner/idempotency uniqueness constraint.

### 4.3 ExtractionReport

- `id`: CUID primary key.
- `jobId`: unique foreign key.
- `schemaVersion`: integer.
- `finalUrl`, `fetchedAt`, `durationMs`.
- `sections`: PostgreSQL JSONB validated through `ExtractionReportSchema` on write and read.
- timestamps.

Raw target HTML, cookie values, authorization headers, and response bodies are never persisted.

### 4.4 AuditEvent

- `id`, `actorId`, `action`, `entityType`, `entityId`.
- `requestId`, `ipHash`, and bounded JSON metadata.
- `createdAt`.

Audit metadata must not contain tokens, cookie values, complete request bodies, or target HTML.

## 5. HTTP API

All application endpoints require JWT authentication except health and metrics. Metrics may optionally require an environment-configured bearer token.

### Extraction endpoints

- `POST /api/extractions` — create a job; returns 202.
- `GET /api/extractions` — cursor-paginated job history owned by the caller; admins may filter by owner.
- `GET /api/extractions/:id` — job and report summary, subject to ownership.
- `POST /api/extractions/:id/cancel` — request cancellation for queued or running jobs.

The old `POST /api/extract` endpoint is removed rather than maintained as a second execution path. The frontend migrates in the same release.

### Operational endpoints

- `GET /health/live` — process event loop is alive; no dependency checks.
- `GET /health/ready` — verifies PostgreSQL, Redis, and, for the worker, Chromium initialization.
- `GET /metrics` — Prometheus text format with request, job, crawl duration, detector error, queue depth, and process metrics.

## 6. Security Design

### 6.1 Authentication and authorization

- Auth0 JWTs use RS256, issuer and audience validation, JWKS caching, and namespaced role claims.
- Development authentication is rejected whenever `NODE_ENV=production`.
- Every job query includes an ownership predicate. Admin access is explicit and covered by tests.
- Resource absence and inaccessible ownership both return 404 to avoid identifier enumeration.

### 6.2 SQL injection

- All persistence uses Prisma parameterized queries.
- No `$queryRawUnsafe` or `$executeRawUnsafe` is permitted.
- Search, status, cursor, sort, and pagination fields are allowlisted through Zod enums.
- Security tests submit SQL metacharacters in URLs, IDs, cursors, idempotency keys, and filters and verify that no query semantics change.
- A static guard test scans production TypeScript for unsafe Prisma raw-query APIs.

### 6.3 SSRF and URL abuse

- Permit only `http:` and `https:`.
- Reject URL credentials, non-default ports unless explicitly allowlisted, invalid IDNs, oversized URLs, and blocked host suffixes.
- Resolve all A and AAAA records and reject any non-public address.
- Revalidate the actual remote address and every redirect target.
- Disable automatic unrestricted redirect following; navigation follows a bounded redirect policy.
- Block localhost, RFC1918, loopback, link-local, carrier-grade NAT, benchmarking, multicast, documentation, reserved IPv4 ranges, IPv4-mapped IPv6, unique-local IPv6, link-local IPv6, and cloud metadata hosts.
- Cap redirects, total responses, response metadata, HTML size, network-log entries, script metadata, and crawl duration.

DNS rebinding cannot be eliminated solely through pre-resolution. The worker must compare the browser connection target where Playwright exposes it and otherwise abort requests whose host resolves to a blocked address immediately before dispatch.

### 6.4 Injection and browser-content safety

- Target HTML is treated as untrusted data and never rendered as HTML in the web application.
- Report data is rendered as text or JSON only.
- Error messages returned to clients use stable public codes and never include stack traces, SQL details, filesystem paths, secrets, or arbitrary exception messages.
- Headers are protected with Helmet and a restrictive Content Security Policy suitable for the React bundle and Auth0.
- Request bodies are limited to 16 KiB; URL and header fields have explicit maximum lengths.
- Object schemas are strict so unknown keys are rejected, reducing mass-assignment and prototype-pollution risk.
- Logs redact authorization, cookies, tokens, passwords, and configured secret names.

### 6.5 Abuse controls

- Rate limits distinguish job creation from cheap read endpoints.
- Job creation is limited by authenticated subject and source IP.
- Per-user active-job limits prevent queue monopolization.
- Worker concurrency is environment-configured and defaults conservatively.
- Idempotency prevents accidental duplicate crawls.
- Cancellation and timeout release browser contexts in `finally` blocks.

## 7. Error Model

Public errors retain the shared shape and add job-specific codes:

- `VALIDATION`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`.
- `CONFLICT`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`.
- `URL_NOT_ALLOWED`, `QUEUE_UNAVAILABLE`.
- `CRAWLER_TIMEOUT`, `CRAWLER_TARGET`, `CRAWLER_LIMIT`.
- `INTERNAL`.

Each response includes `requestId`. Field errors use arrays of `{path, message}`. Internal logs contain the causal exception associated with the same request/job ID, while the public response remains sanitized.

## 8. Frontend Design

The existing feature-based structure remains. The extraction feature gains:

- an API client that parses every successful and unsuccessful response with shared Zod schemas;
- a submission hook that creates a job and polls it with capped exponential backoff;
- job status and cancellation controls;
- a history page with cursor pagination;
- accessible loading, empty, failure, cancellation, and success states;
- localized human-readable section labels while preserving technical dimensions;
- report evidence rendered as text with confidence badges.

Routes become:

- `/login`, `/callback` — authentication flow.
- `/` — authenticated extraction dashboard.
- `/history` — authenticated job history.
- `/extractions/:id` — authenticated job/report detail.

All application routes except login and callback pass through `RequireAuth`.

## 9. Observability and Operational Maturity

### 9.1 Logging

- Pino JSON logging in API and worker.
- Incoming `X-Request-Id` is accepted only when it matches a bounded safe format; otherwise a UUID is generated.
- API request ID, Auth0 subject, job ID, attempt, duration, result, and stable error code are structured fields.
- Sensitive fields are redacted centrally.

### 9.2 Metrics

Prometheus metrics include:

- HTTP request count and duration by route template, method, and status.
- Jobs created and completed by terminal status.
- Queue waiting/active counts.
- Crawl and detector duration histograms.
- Detector failures by dimension.
- Worker active contexts and process resource metrics.

Metrics never use raw URLs, user IDs, job IDs, or exception messages as labels.

### 9.3 Health and shutdown

- Liveness never depends on PostgreSQL, Redis, Auth0, or external targets.
- Readiness fails when a required local dependency is unavailable.
- API stops accepting new connections during shutdown.
- Worker pauses queue consumption, waits for the active job up to a bounded grace period, closes Chromium, and disconnects Redis/PostgreSQL.

### 9.4 Service-level objectives

Initial targets, treated as measurement goals rather than contractual guarantees:

- API non-extraction reads: p95 below 300 ms.
- Job-creation API: p95 below 500 ms when dependencies are healthy.
- Successful job completion: p50 below 10 s and p95 below 30 s for ordinary public pages.
- Monthly API availability target: 99.5% for the initial controlled deployment.
- Maximum queued wait alert: 60 s.
- Failed-job ratio alert: above 10% for 10 minutes.

## 10. Testing Strategy

### 10.1 Unit tests

- Shared Zod contracts: strictness, bounds, discriminated states, pagination, and error schemas.
- URL safety: IPv4, IPv6, mapped addresses, credentials, ports, IDNs, redirect targets, DNS failures, and mixed public/private answers.
- Guards: missing token, malformed claims, user/admin roles, ownership, and development-mode restrictions.
- Services: idempotency, state transitions, cancellation, retries, report validation, error sanitization, and audit creation.
- Every detector has at least positive, negative, and evidence-contract coverage.
- Frontend hooks and components cover success, polling, cancellation, API schema mismatch, empty, and error states.

### 10.2 Integration tests

- Prisma repositories run against an isolated PostgreSQL test database.
- BullMQ integration runs against isolated Redis keys and verifies enqueue, retry, cancellation, and deduplication.
- Nest API tests use real validation, filters, guards, controllers, services, and repositories with only Auth0 signature verification substituted by a deterministic test strategy.
- Security integration cases exercise SQL injection strings, unknown object keys, oversized input, malicious IDs, ownership boundaries, unsafe URLs, and sanitized errors.

### 10.3 End-to-end tests

- API E2E: create job, observe queued/running/succeeded states, retrieve persisted report, list history, cancel, retry failure, and enforce ownership/admin behavior.
- Browser E2E: development login, submit URL, progress display, successful report, failed extraction, cancellation, history navigation, and unauthorized redirect.
- Crawling E2E uses a controlled local fixture service with public-target safety injected through a test-only resolver interface. Production URL protections are not disabled globally.

No E2E test depends on arbitrary public websites or a real Auth0 tenant.

## 11. Delivery and Deployment

Docker Compose defines PostgreSQL, Redis, API, worker, and web. Application images use multi-stage builds, pinned major runtime images, non-root users, read-only filesystems where Playwright permits them, explicit health checks, and named volumes only for stateful services.

Environment validation is centralized with a Zod schema and runs before either API or worker starts. Production boot fails for missing secrets, placeholder Auth0 values, development auth, permissive CORS, or invalid concurrency and timeout settings.

Database migrations run as an explicit release step, not automatically in every application replica. Deploy order is migrate, start worker, start API, then web. Rollback retains backward-compatible database columns for this delivery; destructive schema cleanup is excluded.

## 12. Implementation Boundaries

Included:

- asynchronous durable extraction;
- report persistence and history;
- API and worker operational endpoints;
- security hardening and automated security regression tests;
- unit, integration, API E2E, and browser E2E coverage;
- local container deployment and runbooks.

Excluded:

- billing and subscription tiers;
- organization or multi-tenant workspaces beyond individual ownership;
- source-code repository analysis;
- multi-page crawling;
- distributed tracing backend deployment;
- Kubernetes manifests and cloud-provider-specific infrastructure;
- automatic reprocessing schedules.

These exclusions prevent the delivery from becoming a product redesign while still establishing production-oriented foundations.

## 13. Migration Strategy

Implementation proceeds in independently verifiable slices:

1. Restore build, typecheck, lint, and deterministic test infrastructure.
2. Harden shared contracts, error handling, authentication, authorization, and URL safety.
3. Add the persistence model and repository-backed job lifecycle.
4. Add Redis/BullMQ and the worker process.
5. Migrate HTTP endpoints and frontend flows to asynchronous jobs.
6. Add logs, metrics, health, shutdown, Docker, and operational documentation.
7. Complete integration, API E2E, browser E2E, security regression, and full verification.

Each slice must keep the repository buildable and must be implemented test-first for production behavior changes.
