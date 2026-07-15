# 0001 — pnpm workspaces

- Status: Accepted
- Date: 2026-07-14

## Context

Three workspaces need to share TypeScript and a Zod contract:
- `apps/api` (NestJS)
- `apps/web` (Vite)
- `packages/shared` (Zod schemas + types)

## Decision

Use **pnpm workspaces** for the monorepo.

- Hard-link sharing for `node_modules` — fast install, low disk.
- First-class `workspace:*` protocol for cross-package deps.
- No build-orchestration layer (Turborepo / Nx) in v1; pnpm's filter flags cover the dev/build/lint needs.

## Consequences

- One `pnpm-lock.yaml` at root.
- Cross-package imports are explicit: `import { ExtractRequestSchema } from '@extractionstack/shared'`.
- CI must use pnpm (`corepack enable && corepack prepare pnpm@9.0.0 --activate`).

## Alternatives

- **npm workspaces**: works but slower install, weaker filtering.
- **Yarn 4 / PnP**: stronger guarantees but breaks some Nest/Vite tooling assumptions.
- **Turborepo**: would add remote cache and parallel scheduling; not needed for 3 workspaces in v1.
