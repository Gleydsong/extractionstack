# ExtractionStack

Analyze a live URL and produce a structured report describing the target's technology stack: CSS framework, design tokens, typography, grid, animations, SEO, performance, component architecture, icons, and more.

## Status

v0.2 — full extractor. Backend, frontend, **29 detectors** (15 frontend/UI + 14 backend/infra), and docs are in place. Every detector returns **evidence + confidence** (high/medium/low) showing the snippet that triggered detection.

Backend, frontend, detectors, and docs are in place; running it end-to-end requires:

- Auth0 tenant (backend and frontend env vars) — bypassable locally with `AUTH_DEV_MODE=true`
- Postgres (via `docker compose up -d`)
- Playwright Chromium download (`pnpm --filter @extractionstack/api exec playwright install chromium`)

See `docs/ARCHITECTURE.md` for the module map and `docs/superpowers/specs/2026-07-14-extractionstack-design.md` for the full design.

## Detectors (29 sections per report)

**Frontend/UI (15):** `cssFramework`, `cssCustomization`, `designSystem`, `typography`, `responsive` (merged with grid), `animation`, `scrollAnimation`, `transition`, `seo`, `performance`, `componentArchitecture`, `designTokens`, `palette`, `icons`, plus the merged `gridSystem` data inside `responsive`.

**Backend/Infra (14):** `backendFramework`, `language`, `libraries`, `stateManagement`, `routing`, `authProvider`, `apisConsumed`, `thirdPartyServices`, `analytics`, `cdn`, `cloudProvider`, `reverseProxy`, `databaseIndicators`, `dockerKubernetes`, `architecture`.

Each `ok` result includes an `evidence[]` array with `{source, snippet, confidence, note?}` — the actual URL, header line, or HTML chunk that triggered the hit, plus a high/medium/low confidence badge.

## Auth0 setup (v1 contract)

The backend looks for the role claim at the **namespaced** path `https://extractionstack/roles`. Add an Action in your Auth0 tenant (post-login trigger) that emits the claim:

```js
exports.onExecutePostLogin = async (event, api) => {
  const roles = event.authorization?.roles ?? [];
  api.idToken.setCustomClaim('https://extractionstack/roles', roles);
  api.accessToken.setCustomClaim('https://extractionstack/roles', roles);
};
```

In your Auth0 API settings, define a permission (e.g. `extract:run`) and assign roles `user` and `admin` to it. The backend's `RolesGuard` will accept either role for the `/api/extract` endpoint. Add a stricter `Roles('admin')` decorator on a future admin route when you have one.

## Stack

- **Frontend:** React 18, Vite, React Router, `@auth0/auth0-react`
- **Backend:** NestJS 10, Prisma 5, Auth0 RS256 (Passport JWT + jwks-rsa), Playwright Chromium, Zod, Helmet, Throttler
- **DB:** PostgreSQL 16 (Docker)
- **Monorepo:** pnpm workspaces, TypeScript 5

## Quickstart

```bash
# 1. Install
pnpm install

# 2. Postgres
docker compose up -d

# 3. Env
cp .env.example .env
# fill in AUTH0_* and VITE_AUTH0_* values

# 4. Prisma
pnpm prisma:generate
pnpm prisma:migrate

# 5. Playwright browser
pnpm --filter @extractionstack/api exec playwright install chromium

# 6. Dev
pnpm dev
# api: http://localhost:3001
# web: http://localhost:5173
```

## Layout

```
extractionstack/
├── apps/
│   ├── api/                NestJS
│   └── web/                React + Vite
├── packages/
│   ├── shared/             Zod schemas + types (single source of contract)
│   └── eslint-config/
├── docs/
│   ├── plan.md             Original idea
│   ├── ARCHITECTURE.md     Module map
│   ├── decisions/          ADRs
│   └── superpowers/specs/  Design + planning artifacts
├── docker-compose.yml
└── README.md
```

## Scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Run api and web in parallel |
| `pnpm dev:api` / `pnpm dev:web` | Run only one |
| `pnpm build` | Build all workspaces |
| `pnpm typecheck` | TypeScript check |
| `pnpm lint` | Lint |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm prisma:generate` | Generate Prisma client |
| `pnpm prisma:migrate` | Apply migrations (dev) |

## Architecture principles

SOLID, YAGNI, KISS, DRY. See `docs/decisions/` for the ADRs that put these into practice.

## License

UNLICENSED — internal project.
