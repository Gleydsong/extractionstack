# 0006 — Zod shared contract

- Status: Accepted
- Date: 2026-07-14

## Context

Frontend and backend need to agree on the request and response shape. Drift is the most common source of bugs in fullstack apps.

## Decision

Define all cross-boundary types in `packages/shared` as **Zod schemas**. Export both the schemas and the inferred TypeScript types.

- Backend: `ZodValidationPipe` parses incoming payloads against the request schema; controller responses are typed against the inferred type.
- Frontend: `useExtract` parses the response with the same schemas, so a contract drift produces a parse error visible to the user instead of a silent UI bug.

## Consequences

- One source of truth for the contract.
- Runtime validation on both sides.
- Slight bundle-size cost on the frontend (Zod is ~12KB gzipped) — acceptable.
- Discriminated unions (`DetectorResult`) work cleanly with Zod's `discriminatedUnion` / `status` enum.

## Alternatives

- **OpenAPI / generated types**: bigger setup, more tools. Zod is enough for v1.
- **Hand-written types only**: no runtime validation, drift is silent. Rejected.
- **GraphQL with codegen**: solves the same problem differently; we don't need GraphQL's flexibility for a single endpoint.
