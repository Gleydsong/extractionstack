# 0003 — Detector plugin pattern

- Status: Accepted
- Date: 2026-07-14

## Context

We have 14+ extraction dimensions, all of which read the same `CrawledPage` and produce a typed result. Each dimension evolves independently (new framework signatures, new heuristics). Naïvely inlining all 14 into `ExtractService` would balloon the service and couple every dimension to every other.

## Decision

Each detector implements the `Detector<TData>` interface from `apps/api/src/extract/detectors/detector.interface.ts`. A base class `BaseDetector<TData>` provides `ok`/`skipped`/`error` helpers and a discriminator tag.

Detectors are registered in `apps/api/src/extract/detectors/registry.ts` as a list. `ExtractService` runs them with `Promise.all`, never calling one detector from another, and wraps each call in `try/catch` so a single failure doesn't fail the report.

## Consequences

- **OCP** (Open/Closed): add a detector = add a class + one line in the registry. `ExtractService` is unchanged.
- **ISP** (Interface Segregation): each detector's `data` is its own type. Consumers narrow with `status === 'ok'`.
- **DIP** (Dependency Inversion): `ExtractService` depends on the `Detector` interface, not on concrete classes.
- **DRY**: the wrapper (try/catch, error shape, ordering) lives in one place.
- **Testability**: each detector is unit-testable with a fixture `CrawledPage` — no I/O.

## Trade-off

A small amount of indirection (interface + base class) for a real extensibility win. The indirection is constant size; the detector count is variable.
