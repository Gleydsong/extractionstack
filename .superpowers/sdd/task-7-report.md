# Task 7 — AI Connections API and Gemini OAuth

## Status

GREEN. Owner-scoped OpenAI/Gemini API-key connections, Gemini OAuth, provider capabilities,
validation, masking, idempotency, revalidation, and local-first revocation are implemented.

## RED evidence

Command:

```text
pnpm --filter @extractionstack/api test -- ai-connections
```

Initial result: 2 suites failed because `ai-connections.service.ts` and
`ai-connections.controller.ts` did not exist. The existing credential-vault suite remained green
(25 tests), confirming that the new tests failed for the missing feature rather than a regression.

The initial RED tests covered:

- masked responses that never contain the submitted API key;
- remote verification before API-key activation;
- one-time OAuth state and replay rejection;
- OAuth expiry, PKCE, and exact redirect allowlisting;
- indistinguishable 404 behavior for another owner;
- local-first revocation and sanitized OAuth errors.

## GREEN implementation

- Added authenticated connection list/add/revalidate/delete endpoints and unauthenticated,
  one-time Gemini callback.
- Added `GET /api/ai/providers`, backed by the approved `ProviderRegistry`; OpenAI OAuth is not
  advertised.
- Added safe metadata-only provider verification (`GET /models`), with injected fetch, timeout,
  no paid generation, bounded OAuth response bodies, and sanitized failures.
- Added Gemini authorization-code exchange with exact redirect URI, S256 PKCE, configured client
  credentials, official Google scopes, and encrypted access/refresh tokens. OIDC nonce is not used
  because this flow does not request or validate identity tokens.
- Added Redis-backed OAuth state keyed only by SHA-256, TTL, and an atomic Lua consume operation
  that writes a bounded hashed `usedAt` marker before deleting the active state.
- Added mutation idempotency keyed by owner/operation/idempotency-key hashes. PostgreSQL is the
  durable source of truth; a Redis lease and schema-validated public-result cache accelerate replay.
  Credential plaintext and raw idempotency keys are never stored.
- Added strict canonical Prisma `Bytes`/metadata mapping for `CredentialEnvelope` and rejected
  malformed or extra metadata.
- Added owner predicates to every repository read/mutation and transactionally audited create,
  validate, and revoke operations.
- OAuth initiation persists the authenticated owner; callback resolves the current owner by `sub`
  and never replays role/profile data from OAuth state.
- Local revocation is authoritative and occurs before best-effort Google revocation.
- Added fail-closed runtime configuration and documented Gemini OAuth environment variables.

## Focused verification

```text
pnpm --filter @extractionstack/api test -- ai-connections credential-vault
```

Result: 5 files passed, 48 tests passed, 0 failed.

```text
pnpm --filter @extractionstack/api typecheck
```

Result: PASS (API and API e2e TypeScript configurations).

## Full workspace verification

```text
pnpm verify
```

Result: PASS.

- lint: all workspace projects passed;
- typecheck: all workspace projects passed;
- tests: shared 12, llm-core 124, worker 8, web 10, API 184 — all passed;
- build: shared, llm-core, worker, web, and API passed.

## Review findings resolved

- OAuth tokens are remotely verified before `ACTIVE`.
- OAuth state no longer snapshots or restores mutable authorization/profile data.
- Gemini OAuth verification sends `x-goog-user-project`.
- authenticated mutation endpoints propagate and persist idempotency results.
- provider endpoint consumes `ProviderRegistry`.
- repository tests exercise owner predicates, revoke/audit transaction, and envelope round-trip.
- consumed OAuth state keeps a bounded hashed `usedAt` marker without allowing replay.
- the initial independent security-review findings were resolved before controller review.

## Concerns / operational notes

- Gemini OAuth is omitted from capabilities and disabled when its four required values are absent.
- Redis is required for OAuth state and OAuth-start replay; mutation durability is PostgreSQL-backed
  and Redis is only an acceleration cache.
- Remote provider revocation is deliberately best effort; a remote failure never reactivates the
  locally revoked connection.

## Controller review remediation — 2026-07-17

### RED evidence

The focused review suite initially failed 7 tests: the durable idempotency migration was missing,
validation could audit a zero-row update, OAuth still emitted nonce, oversized streams were not
cancelled, the registry had no environment-aware factory, and OAuth-start replay was plaintext.

### Changes

- OAuth-start cache values now contain only an authenticated `CredentialVault` envelope. State and
  authorization URL replay only after owner/provider-bound decryption; tampering fails closed.
- Added `MutationIdempotency` and migration `20260717010000_add_mutation_idempotency`. Add,
  revalidate, revoke, public result, entity ID, and audit commit in one Prisma transaction under a
  unique owner/operation/key-hash constraint. Redis failures reconcile through PostgreSQL.
- Removed nonce and pseudo-`id_token` handling from the OAuth API and token client.
- Gemini advertises OAuth only with a complete configuration; OpenAI never advertises OAuth.
- Bounded provider response readers cancel the stream on declared or observed overflow/read errors.
- Validation requires exactly one eligible row before auditing, preventing false audit events when
  revocation wins a race.
- Added opt-in PostgreSQL integration coverage for ownership, encrypted envelope round-trip,
  durable retries with Redis down, same-key concurrency, validation/revocation, and audit counts.

### Verification

```text
DATABASE_URL=postgresql://... pnpm --filter @extractionstack/api exec prisma migrate deploy
```

Result: all 4 migrations applied to a fresh isolated PostgreSQL 16 database.

```text
TEST_DATABASE_URL=postgresql://... pnpm --filter @extractionstack/api exec vitest run \
  src/ai-connections/ai-connections.repository.integration.spec.ts
```

Result: 1 file passed, 3 PostgreSQL integration tests passed.

```text
pnpm verify
```

Result: PASS — lint, typecheck, workspace tests, and all production builds. The API suite reports
190 passed and 3 opt-in PostgreSQL tests skipped when `TEST_DATABASE_URL` is absent; those same 3
tests passed in the isolated database run above.
