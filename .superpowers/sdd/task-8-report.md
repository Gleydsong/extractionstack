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
