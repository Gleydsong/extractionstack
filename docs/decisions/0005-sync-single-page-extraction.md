# 0005 — Sync single-page extraction

- Status: Superseded by ADR 0007
- Date: 2026-07-14

## Context

Crawling a single URL through Playwright takes 5-30s depending on the target. We need to decide whether the frontend waits for the report (sync) or polls a job queue (async).

## Decision

**Synchronous**: `POST /api/extract` runs the full crawl + detect pipeline and returns the report. The browser holds the request open for up to 25s.

## Consequences

- No queue, no jobs table, no polling, no retention — KISS.
- No persistence of past reports in v1 (matches the no-history design choice).
- Throttler (`@nestjs/throttler`, 10 req / user / min) protects against abuse.
- Failure mode: timeout (25s) returns 504 `CRAWLER_TIMEOUT`; target 4xx/5xx returns 502 `CRAWLER_TARGET`. Both are surfaced to the user.

## When to revisit

- Multi-page crawl is added (v2): sync won't fit, async jobs become required.
- Crawl time exceeds ~10s p95 for typical targets: hard to justify keeping the connection open.
- Per-tenant isolation needs: a queue is the natural place to enforce per-tenant limits.

## Alternatives

- **Async + BullMQ + Postgres jobs table**: more moving parts, but enables long crawls and per-job observability. Deferred to v2.
- **WebSockets streaming partial results**: best UX, highest complexity. Not justified yet.
