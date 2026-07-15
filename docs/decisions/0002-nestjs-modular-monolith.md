# 0002 — NestJS modular monolith

- Status: Accepted
- Date: 2026-07-14

## Context

Backend serves a single synchronous endpoint with a single source of truth (the report). The crawler is in-process. There is no need for independent scaling of subsystems in v1.

## Decision

Build a **modular monolith** with NestJS. One deployable unit, multiple modules:
`AuthModule`, `ExtractModule`, `PrismaModule`, `CommonModule`.

## Consequences

- **KISS / YAGNI**: no service mesh, no distributed tracing, no cross-pod network hops.
- Detector additions stay inside `ExtractModule` (ADR-0003).
- Future split: if crawling throughput becomes a bottleneck, the `PlaywrightCrawler` can be extracted to a worker pool behind a queue (BullMQ) without changing the public API.

## Alternatives

- **Microservices (crawler-svc / detector-svc / gateway)**: rejected — over-engineered for v1. Detector service and crawler share no data, so splitting them adds latency and failure modes for no current benefit.
- **Express + plain modules**: rejected — DI, guards, interceptors, testing harness from Nest are the productivity multiplier. The framework tax is worth it.
