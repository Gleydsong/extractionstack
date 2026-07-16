# Task 8 Report: Idempotent Credit Ledger

## Status

Implemented and verified. The ledger is append-only at the repository/service boundary, uses signed `bigint` minor units throughout, serializes owner-scoped reservations with a parameterized PostgreSQL advisory lock, and enforces one settlement per reservation in the database.

## Implementation

- Added `CreditsModule`, `CreditsService`, and `CreditsRepository`, and registered the module in `AppModule`.
- Added direct and command-based service contracts for:
  - `reserve(ownerId, jobId, estimatedAmount, idempotencyKey, maximumAcceptedAmount?)`
  - `confirm(reservationId, actualAmount)`
  - `reverse(reservationId, reason)`
  - `getAvailableBalance(ownerId)`
- Public amounts are decimal strings. Internal calculations remain `bigint`; there are no `number`, float, `parseInt`, or `parseFloat` conversions.
- Reservation semantics:
  - validates positive estimated and maximum amounts within `1_000_000_000_000` minor units;
  - requires maximum accepted cost to be at least the estimate;
  - verifies that the job belongs to the owner;
  - acquires `pg_advisory_xact_lock(hashtextextended(ownerId, 0))` through Prisma's parameterized tagged `$queryRaw` API;
  - computes the available balance and appends the negative reservation in one transaction;
  - hashes owner and caller idempotency key into an owner-scoped deterministic stored key;
  - stores estimate, accepted maximum, and request hash as bounded decimal-string metadata;
  - replays an identical command and rejects reuse of the same key for a different command.
- Settlement semantics:
  - confirmation appends `estimate - actual`, including positive, zero, and negative deltas;
  - confirmation rejects actual cost above the accepted maximum;
  - reversal appends the full positive estimated amount;
  - confirmation/reversal copy the reservation owner and job scope;
  - deterministic `confirm:<reservationId>` and `reverse:<reservationId>` keys are used;
  - no ledger entry is updated or deleted.
- Balance is the signed sum of the owner's `CREDITS` ledger entries.

## Database Invariants

Migration `20260717020000_add_credit_settlement` adds:

- nullable self-reference `reservationId`;
- a unique index on `reservationId`, making confirmation and reversal mutually exclusive even under a race;
- a foreign key to `CreditLedgerEntry(id)` with restricted deletion;
- a check requiring only `CONFIRMATION`/`REVERSAL` rows to carry a non-self reservation reference and forbidding it on all other kinds.
- a deferred-capable constraint trigger requiring the referenced row to be a `RESERVATION` with the same owner, job, and currency as its settlement.

The existing amount-bound and kind/sign checks remain authoritative for the signed ledger semantics.

## TDD Evidence

Observed red states before implementation:

1. `credits.service.spec.ts` failed because `credits.service.js` did not exist.
2. `credits.persistence.spec.ts` failed because the settlement migration did not exist.
3. `credits.repository.integration.spec.ts` failed because `CreditsRepository` was not implemented.
4. The first PostgreSQL run failed all 9 integration cases because Prisma could not deserialize the `void` return from `pg_advisory_xact_lock`. The query was minimally corrected to cast the lock result to `text`; the owner identifier remains a bound parameter.
5. The command-port test failed before service overloads were implemented, then passed after the service implemented `CreditsPort`.
6. Direct PostgreSQL settlement inserts initially accepted a non-reservation target and cross-owner/job scope; the new constraint-trigger test failed before the migration was hardened, then passed after a fresh database reset.

## Verification Evidence

### Fresh PostgreSQL migration

Command:

```bash
DATABASE_URL=postgresql://extractionstack:extractionstack@127.0.0.1:5432/extractionstack?schema=public \
  pnpm --filter @extractionstack/api exec prisma migrate reset --force
```

Result: all 5 migrations applied successfully to a fresh PostgreSQL 16 database, including `20260717020000_add_credit_settlement`.

### Focused PostgreSQL and unit suite

Command:

```bash
TEST_DATABASE_URL=postgresql://extractionstack:extractionstack@127.0.0.1:5432/extractionstack?schema=public \
  pnpm --filter @extractionstack/api test -- credits
```

Result: 3 files passed, 19 tests passed, 0 failed/0 skipped.

Covered behaviors include concurrent duplicate reservation replay, conflicting reuse, concurrent overspend prevention, insufficient balance rollback, owner/job mismatch rollback, strict reservation metadata, signed confirmation deltas, accepted-cost ceiling, confirm-vs-reverse race, double-settlement rejection, reversal balance, invalid direct settlement targets/scopes, and append-only service/repository behavior.

### API verification

Commands:

```bash
pnpm --filter @extractionstack/api lint
pnpm --filter @extractionstack/api typecheck
pnpm --filter @extractionstack/api test
pnpm --filter @extractionstack/api build
```

Result: all commands exited 0. API tests: 29 files passed, 199 tests passed; 13 PostgreSQL tests were skipped in the default environment and the 10 Task 8 PostgreSQL tests were executed separately by the focused command above.

### Full monorepo verification

Command:

```bash
pnpm verify
```

Result: exit 0 across lint, typecheck, tests, and production builds for all workspace packages.

### Formatting and diff

- Prettier applied to all changed TypeScript files.
- `prisma format` applied to the schema.
- `git diff --check` exited 0.
- Static search found no ledger update/delete methods, unsafe raw SQL, or numeric bigint conversions.

## Residual Concern

PostgreSQL integration tests intentionally skip when `TEST_DATABASE_URL` is absent, matching the repository's existing integration-test convention. They were run explicitly against a fresh local PostgreSQL database for this task; CI should provide `TEST_DATABASE_URL` to keep the concurrency guarantees continuously exercised.

## Review Disposition

An independent review requested database-level target/scope enforcement; this was accepted and implemented with the constraint trigger and direct invalid-insert integration test.

The review also suggested reserving the accepted maximum instead of the estimate. That suggestion was not applied because it conflicts with the binding ledger semantics for this task: `RESERVATION` is the negative estimated amount and `CONFIRMATION` is `estimate - actual`, explicitly allowing a negative delta. The accepted maximum remains a consent/cost ceiling, while concurrent reservation overspend is evaluated from the signed estimated reservations as specified.

The follow-up review withdrew that finding under the binding semantics and reported no remaining blocking findings.

## Controller Review Follow-up: Resolved After Temporary Block

Status: **RESOLVED — PostgreSQL validation resumed and completed before commit.**

The controller review requested database-enforced append-only retention and stronger settlement locking. The follow-up contains:

- migration `20260717030000_make_credit_ledger_append_only` with a `BEFORE UPDATE OR DELETE` trigger that raises stable constraint `CreditLedgerEntry_append_only_check`;
- `CREATE OR REPLACE` of the settlement validation function with `FOR KEY SHARE` on the referenced reservation;
- PostgreSQL integration cases for direct ledger update/delete rejection, settled-reservation owner/job/currency/kind mutation rejection, and settlement-versus-target-update concurrency;
- static persistence assertions for the append-only trigger and row lock.

### Follow-up TDD evidence

The persistence test was observed RED because the new migration did not exist:

```text
credits.persistence.spec.ts: 1 failed
ENOENT .../20260717030000_make_credit_ledger_append_only/migration.sql
```

After adding the migration, the safe static/default checks were GREEN:

- `pnpm --filter @extractionstack/api test -- credits.persistence.spec.ts`: 1/1 passed.
- API lint: exit 0.
- API typecheck: exit 0.
- Default credits suite: 9 passed, 13 PostgreSQL tests skipped.
- API build: exit 0.
- `pnpm verify`: exit 0; API default suite reported 199 passed and 16 PostgreSQL tests skipped across integration suites.
- `git diff --check`: exit 0.

### Historical blocking condition

At that checkpoint, the required fresh PostgreSQL reset/migration and the 13 real credits integration tests could not be run. Docker escalation was rejected by the platform usage-limit policy, and the coordinator explicitly prohibited workarounds. Therefore the SQL trigger behavior, stable Prisma constraint mapping, row-lock race, and fresh migration chain were not yet verified.

Per coordinator instruction, these follow-up changes remained uncommitted until a later session with PostgreSQL access could run:

```bash
DATABASE_URL=<isolated-postgresql-url> \
  pnpm --filter @extractionstack/api exec prisma migrate reset --force

TEST_DATABASE_URL=<isolated-postgresql-url> \
  pnpm --filter @extractionstack/api test -- credits
```

The existing `TEST_DATABASE_URL` CI gap remained a Minor concern owned by Task 16; no CI service was added here.

### Resumed isolated PostgreSQL evidence

PostgreSQL access was restored in a later turn. Validation used the unique database `task8_append_61855b0_a7f3c9` in the worktree's existing PostgreSQL 16 Compose service; the developer database was not reset or modified.

Creation and fresh migration result:

```text
6 migrations found
20260714161343_init applied
20260715000100_jobs_reports applied
20260716120000_add_llm_prompt_generation applied
20260717010000_add_mutation_idempotency applied
20260717020000_add_credit_settlement applied
20260717030000_make_credit_ledger_append_only applied
All migrations have been successfully applied.
```

The first real PostgreSQL run produced the expected diagnostic cycle: 10 tests passed and 3 new append-only tests failed because Prisma 5 preserved SQLSTATE `23514` and the stable database message but did not expose the PostgreSQL `CONSTRAINT` field in its JavaScript error text. The tests were corrected to assert the observable stable contract (`code: "23514"` and `credit ledger entries are append-only`) without changing the trigger.

Fresh focused results after that correction:

- `TEST_DATABASE_URL=... pnpm --filter @extractionstack/api test -- credits.repository.integration.spec.ts`: 13/13 passed.
- `TEST_DATABASE_URL=... pnpm --filter @extractionstack/api test -- credits`: 3 files passed, 22/22 tests passed, 0 skipped.
- Existing reservation, confirmation, reversal, balance, idempotency, rollback, and settlement-race flows remained green.
- New direct update/delete, post-settlement scope mutation, and concurrent settlement-versus-update cases passed.

Final verification:

- API lint: exit 0.
- API typecheck: exit 0.
- API default tests: 29 files passed, 199 tests passed; 16 PostgreSQL tests skipped in the default environment and exercised separately where owned by this task.
- API build: exit 0.
- `pnpm verify`: exit 0 across monorepo lint, typecheck, tests, and builds.
- Prettier, `prisma format`, and `git diff --check`: exit 0.

Cleanup: only `task8_append_61855b0_a7f3c9` was dropped after validation. The Compose PostgreSQL service and developer data were left intact.

Residual concern: the default `TEST_DATABASE_URL` CI gap remains Minor and owned by Task 16; no CI service was added in this follow-up.
