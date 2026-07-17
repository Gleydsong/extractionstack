# Task 9 Report — Prompt Project API and Dedicated Queue

## Status

Implemented and verified.

The API now exposes authenticated prompt project create/list/read, universal generation,
immutable-version adaptation, exact-version preview, job read, and guarded cancellation routes.
Generation execution remains intentionally absent; Task 10 owns the LLM worker.

## Implemented scope

- Added strict shared request/list contracts for generation, adaptation, preview, provider/model,
  owned connection selection, platform-credit consent, decimal minor-unit ceiling, and bounded
  cursor pagination.
- Added `PromptProjectsModule`, three thin route controllers, orchestration service, owner-scoped
  Prisma repository, and dedicated BullMQ adapter.
- Added queue `llm-generations-v1` with payload exactly `{ jobId }`, domain job ID as BullMQ ID,
  three exponential attempts, bounded successful retention, and failed-job retention.
- Added durable PostgreSQL mutation idempotency in the same transactions as project/job/audit
  creation. Raw caller idempotency keys are hashed before persistence.
- Replays refresh the current database job state. A replay of a still-queued mutation safely
  retries the idempotent credit reservation and queue handoff; BullMQ deduplicates by domain job
  ID. A replay of a terminal job neither charges nor enqueues again.
- Added strict bounded `requestMetadata` JSON. It accepts only an optional allowlisted adaptation
  destination and cannot store provider payloads, raw HTML, secrets, or arbitrary metadata.
- Added truthful registry/model/mode checks and owner-scoped `ACTIVE` connection checks. Platform
  credits require explicit consent and a positive decimal maximum; there is no automatic paid
  fallback.
- Added reservation-before-enqueue orchestration. Queue failure marks the owned job terminal,
  reverses the reservation, sanitizes the public failure, and reconciles an open reservation on
  replay if the first reversal was interrupted.
- Queued cancellation becomes terminal `CANCELLED`, removes only waiting/delayed Bull jobs, and
  reverses an open platform-credit reservation exactly once. Running cancellation becomes
  `CANCEL_REQUESTED` for cooperative Task 10 handling.
- Added transaction-safe prompt version sequence allocation using a per-project PostgreSQL
  advisory transaction lock.
- Added PostgreSQL triggers for append-only prompt versions, same-project source/result/current
  version references, project/extraction owner consistency, job/project owner consistency, and
  owned active provider connection consistency.

## TDD evidence

### Initial RED — public DTOs and absent API module

Commands:

```text
pnpm --filter @extractionstack/shared test -- prompt-projects.spec.ts
pnpm --filter @extractionstack/api test -- prompt-projects prompt-generation.queue
```

Observed expected failures:

- shared: 3 failed, 8 passed because the command/list schemas were undefined;
- API: 3 suites failed, 1 passed because service, controller, and queue files were absent.

### Persistence RED

Command:

```text
pnpm --filter @extractionstack/api test -- prompt-persistence.spec.ts
```

Observed expected result: 2 failed, 9 passed because the Task 9 migration and bounded job
metadata field did not exist.

### Replay/cancellation RED

Focused tests failed for the intended missing behaviors:

- Bull transport replay still called `add` for an existing job;
- durable queued replay did not re-run safe handoff orchestration;
- cancellation did not forward its idempotency key or reverse/retry an open reservation;
- queue-failure reversal interruption was not reconciled on replay;
- API-key queue failure leaked the internal Redis error instead of returning sanitized 503.

### PostgreSQL RED

The first real repository run failed 5/5 because a Prisma row was spread into a strict public
project schema and exposed internal `ownerId`. After that fix, 2/5 still failed because durable
replay returned the stored `QUEUED` snapshot rather than the current terminal row; this also
caused a second reversal attempt against an already settled reservation. Both defects were fixed
before the suite was expanded.

### Final GREEN

```text
pnpm --filter @extractionstack/shared test -- prompt-projects.spec.ts
# 11 passed

pnpm --filter @extractionstack/api test -- prompt-projects prompt-generation.queue
# 32 passed, 10 environment-gated integration tests skipped in this no-env invocation

TEST_DATABASE_URL=postgresql://.../extractionstack_task9_fresh?schema=public \
  pnpm --filter @extractionstack/api test -- prompt-projects.repository.integration.spec.ts
# 8 passed against PostgreSQL 16

TEST_REDIS_URL=redis://127.0.0.1:6379 \
  pnpm --filter @extractionstack/api test -- prompt-generation.queue.integration.spec.ts
# 2 passed against Redis 7 with unique prefix and queue obliteration
```

The PostgreSQL suite covers extraction/project/connection ownership, inaccessible cursor scope,
cross-project references, durable idempotency and audit uniqueness, current terminal replay,
concurrent version sequences, version update/delete rejection, current-version relationship,
queue-failure credit rollback, and queued-cancellation credit reversal.

## Migration verification

A fresh local database `extractionstack_task9_fresh` was created. `prisma migrate deploy` applied
all seven migrations from the initial schema through
`20260717040000_enforce_prompt_version_invariants` successfully. The 8-test PostgreSQL integration
suite then passed against that fresh database.

## Repository verification

Final command:

```text
pnpm verify
```

Result: PASS.

- lint: all workspace packages passed;
- typecheck: all workspace packages and API E2E TypeScript passed;
- tests: 380 passed across the monorepo; 26 environment-gated tests skipped in the ordinary
  no-env root run and were covered separately for Task 9 with real PostgreSQL/Redis;
- build: shared, LLM core, worker, web production bundle, and Nest API passed;
- `git diff --check`: passed.

## Boundaries and remaining work

- Task 9 does not execute LLM requests, compose provider payloads, persist provider responses, or
  create prompt results in a worker. Task 10 must consume `{ jobId }`, enforce cooperative running
  cancellation, and use the repository's immutable version creation path.
- The standard Vitest invocation intentionally skips real PostgreSQL/Redis suites when
  `TEST_DATABASE_URL`/`TEST_REDIS_URL` are absent; both suites were explicitly run and passed here.
