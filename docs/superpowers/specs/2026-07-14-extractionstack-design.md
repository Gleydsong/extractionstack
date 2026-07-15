# ExtractionStack — Design Spec

**Date:** 2026-07-14
**Status:** Approved (v1)
**Author:** opencode (brainstorming session)
**Source idea:** `docs/plan.md`

## Purpose

A web application that analyzes a live URL and produces a structured report describing the target's technology stack: CSS framework, design tokens, typography, grid, animations, SEO, performance, component architecture, icons, **state, routing, auth, APIs, 3rd-party services, analytics, CDN, cloud provider, reverse proxy, database hints, Docker/Kubernetes, and backend framework/language** — each backed by **evidence + confidence**.

Non-goals (v1):

- Source code upload / Git analysis.
- Multi-page crawls.
- History, export, persistence of past reports.
- Admin UI.
- Cost-based / paid tiers.

## Architecture

Monorepo with three workspaces (pnpm):

```
extractionstack/
├── apps/
│   ├── api/                NestJS backend
│   └── web/                React + Vite frontend
├── packages/
│   ├── shared/             Zod schemas + DTOs (consumed by both ends)
│   └── eslint-config/      Shared lint rules
├── docs/
│   ├── plan.md             Original spec
│   ├── ARCHITECTURE.md     Module map + boundaries
│   ├── decisions/          ADRs
│   └── superpowers/specs/  Design + planning artifacts
├── docker-compose.yml      Postgres for local dev
├── package.json            pnpm workspaces root
└── README.md
```

### Backend (`apps/api`)

NestJS modules:

- `AuthModule` — Auth0 RS256 JWT validation, JWKS cache, `JwtAuthGuard`, `RolesGuard`.
- `ExtractModule` — `ExtractController` (POST `/extract`), `ExtractService` (orchestrator), `PlaywrightCrawler` (singleton), **29 detector services** (15 frontend/UI + 14 backend/infra).
- `PrismaModule` — wraps `PrismaService`.
- `CommonModule` — global `ZodValidationPipe`, `HttpExceptionFilter`, `LoggingInterceptor`.

Each detector implements:

```ts
interface Detector<TData = unknown> {
  readonly dimension: Dimension;
  detect(page: CrawledPage): Promise<DetectorResult<TData>>;
}
```

`DetectorResult` is discriminated and includes optional evidence:

```ts
type DetectorResult<T> =
  | { dimension: Dimension; status: 'ok'; data: T; evidence?: Evidence[] }
  | { dimension: Dimension; status: 'skipped'; reason: string }
  | { dimension: Dimension; status: 'error'; error: string };

type Evidence = {
  source: 'html' | 'header' | 'script' | 'link' | 'meta' | 'network' | 'computedStyle' | 'cookie' | 'path';
  snippet: string;     // the actual URL, header line, or HTML chunk
  confidence: 'high' | 'medium' | 'low';
  note?: string;       // optional human-readable hint
};
```

**Every detector returns evidence when it has a hit.** The frontend renders the evidence list under each section with a `[high]/[medium]/[low]` confidence badge. This is the pattern the image's prompt asked for ("Para cada conclusão, informe: evidência encontrada, grau de confiança, o trecho que levou à conclusão").

### Frontend (`apps/web`)

React + Vite. Feature-based organization. Vite dev server proxies `/api` to `http://localhost:3001` so the browser always sees same-origin in dev (no CORS gymnastics).

```
src/features/
  auth/         WebAuthProvider (Auth0 + DEV_MODE bypass), LoginPage, CallbackPage, RequireAuth, Header
  extract/      HomePage, UrlForm, useExtract, ReportView, ReportSection (renders evidence)
src/components/ Shared UI primitives
src/lib/        API client (fetch + Zod parse)
src/routes.tsx  React Router v6
```

### Shared (`packages/shared`)

- `schemas/common.ts` — `EvidenceSchema`, `ConfidenceSchema`, `ErrorResponseSchema`.
- `schemas/extract.ts` — `ExtractRequest`, `CrawledPage` (with `cookies[]` and per-response `responseHeaders`), `NetworkEntry`, `DetectorResult` (generic), `ExtractionReport`, `Dimension` (29 entries).
- `schemas/auth.ts` — `UserRole`, `Auth0User`.
- Imported by both `apps/api` and `apps/web` so the contract is single-source.

## Data flow

```
User → POST /api/extract {url}
  → ZodValidationPipe (ExtractRequestSchema)
  → JwtAuthGuard (Auth0 RS256, bypassed in AUTH_DEV_MODE)
  → RolesGuard(['user','admin'])
  → ExtractController
    → ExtractService.extract(url)
      → PlaywrightCrawler.crawl(url)  →  CrawledPage
          { html, finalUrl, headers, responseHeaders,
            networkLog (per-request: status, contentType, responseHeaders, size),
            cookies, meta, scripts, stylesheets, linkRel,
            computedStyles, perfTiming, fetchedAt }
      → Promise.all(detectors.map(d => d.detect(page)))
      → merge responsive+grid into single "responsive" section
      → sort by DETECTOR_LIST order
  → 200 ExtractionReport
```

## Detectors (29 — shipped in v1)

### Frontend / UI (15)
1. `CssFrameworkDetector` — Tailwind / Bootstrap / Tachyons / Bulma / Foundation
2. `CssCustomizationDetector` — CSS custom-property layer, CSS-in-JS runtime extraction
3. `DesignSystemDetector` — Material, Chakra, MUI, Radix, shadcn/ui, Ant, Mantine
4. `TypographyDetector` — font-family stack, weights, scale ratio from h1–h6
5. `ResponsiveDetector` — media queries, container queries, viewport
6. `GridSystemDetector` — flex/grid usage (merged with #5 in the report)
7. `AnimationDetector` — CSS keyframes, GSAP/Framer/AOS detection
8. `ScrollAnimationDetector` — Lenis / Locomotive / scroll-linked libs
9. `TransitionDetector` — route transition libs, view-transitions API
10. `SeoDetector` — meta, OG, Twitter, canonical, sitemap, robots, JSON-LD
11. `PerformanceDetector` — `PerformanceNavigationTiming`, lazy-loading, preloads
12. `ComponentArchitectureDetector` — React/Next/Nuxt/Svelte/Astro markers, hydration hints
13. `DesignTokensDetector` — CSS custom properties at `:root`, naming convention, scales
14. `PaletteDetector` — sampled background/foreground colors, contrast pairs
15. `IconsDetector` — lucide / heroicons / font-awesome / inline SVG

### Backend / Infra (14)
16. `BackendFrameworkDetector` — Express, Next, Nuxt, PHP, ASP.NET, Phoenix, Nginx, Apache, Caddy, Cloudflare, gunicorn, uvicorn, Werkzeug, puma, unicorn, plus cookie-based inference (Laravel, Rails, Django, Express, Symfony, Java, ASP.NET)
17. `LanguageDetector` — HTML / JS / TS / CSS / SCSS / Python / PHP / C# via script/link src, meta, headers
18. `LibrariesDetector` — React/Vue/Svelte/moment/dayjs/luxon/date-fns/Chart.js/D3/Recharts/Highcharts/lodash/axios/SWR/TanStack-Query/RxJS/Immutable/Zod/Yup/Joi/Formik/React-Hook-Form
19. `StateManagementDetector` — Redux, Redux Toolkit, Zustand, MobX, Jotai, Recoil, XState, Pinia, Vuex, Valtio, NgRx
20. `RoutingDetector` — React Router, Next, Vue Router, Nuxt, SvelteKit, TanStack Router, Wouter, Reach, Gatsby
21. `AuthProviderDetector` — Auth0, Firebase Auth, Supabase, Clerk, NextAuth, Auth.js, Okta, Cognito, Magic.link, WalletConnect, MetaMask
22. `ApisConsumedDetector` — REST vs GraphQL detection from network log
23. `ThirdPartyServicesDetector` — Stripe, PayPal, MercadoPago, Intercom, Zendesk, Segment, Sentry, Datadog, Hotjar, FullStory, LogRocket, Cloudflare Turnstile, reCAPTCHA, hCaptcha, Mapbox, Google Maps, YouTube, Vimeo, Twilio, SendGrid
24. `AnalyticsDetector` — GA, GTM, GA4, Plausible, Fathom, Mixpanel, Amplitude, PostHog, Matomo, Clarity, SimpleAnalytics, Umami
25. `CdnDetector` — Cloudflare, Fastly, CloudFront, Akamai, Bunny, Vercel Edge, Netlify, Incapsula
26. `CloudProviderDetector` — Vercel, Netlify, AWS, GCP, Azure, Cloudflare Pages, Fly, Render, Heroku, DigitalOcean
27. `ReverseProxyDetector` — Nginx, Apache, Caddy, Traefik, HAProxy, Cloudflare proxy, Akamai GHost, Envoy, GCP load balancer
28. `DatabaseIndicatorsDetector` — Laravel / Rails / Django / Express / Symfony / Java / ASP.NET / NextAuth / Auth0 / Supabase / Clerk / Firebase session cookies
29. `ArchitectureDetector` — SSR / SPA / SSG / ISR / MPA + REST/GraphQL + monolith vs distributed (distinct host count)

## Error handling

| Source | Status | Body |
|---|---|---|
| Zod validation fail | 400 | `{code:'VALIDATION', message, fields:{path:msg}[]}` |
| Missing/invalid JWT | 401 | `{code:'UNAUTHENTICATED', message}` |
| Wrong role | 403 | `{code:'FORBIDDEN', message}` |
| Crawler timeout (>25s) | 504 | `{code:'CRAWLER_TIMEOUT', message, targetUrl}` |
| Crawler target 4xx/5xx | 502 | `{code:'CRAWLER_TARGET', message, targetStatus, targetUrl}` |
| Detector throws | — | Detector returns `{status:'error', error:message}`. Service never re-throws. |
| Unexpected | 500 | `{code:'INTERNAL', message:'unexpected error', hint?}` |

Global `HttpExceptionFilter` enforces the shape. No PII in errors. Target HTML is never echoed back.

## Security

- Auth0 RS256, JWKS cached 10 min, kid rotation supported.
- CORS allowlist: dev `http://localhost:5173,http://127.0.0.1:5173`; prod via env. (Vite dev server proxies `/api` to the API, so the browser is same-origin in dev.)
- Crawler navigates only to public URLs the user supplies; no auth state, no cookies sent. Browser context is fresh per request.
- Rate limit: 10 req / user / minute (`@nestjs/throttler`).
- `targetUrl` validated to `http:`/`https:` and a public IP (SSRF guard) — v2 uses DNS resolution + private-IP block.
- `helmet` middleware enabled.

## Testing

- Unit (Vitest): each detector with 5–10 fixture HTML snapshots stored under `apps/api/src/extract/detectors/__fixtures__/`.
- Zod: table-driven positive/negative per schema.
- Crawler: integration test against a local static fixture server (not against real sites in CI).
- E2E (Playwright): web form submit → API happy path with mocked Auth0 token.
- Coverage target 80% on `apps/api/src/extract`, 70% repo-wide.
- TDD: detectors written test-first.

## Performance budget

- p50 /extract < 8s, p95 < 22s, on a single BE pod with one Chromium instance.
- Cold-start Playwright launch: up to 3s acceptable, hidden behind a `/healthz/ready` probe (TODO).
- FE initial JS < 250KB gzipped.

## Observability

- Structured logs (pino), request id per request.
- OpenTelemetry SDK wired but exporters disabled in v1 (opt-in via `OTEL_EXPORTER_OTLP_ENDPOINT`).
- `/metrics` Prometheus endpoint (v2).

## Decisions / ADRs

Stored in `docs/decisions/`:

- `0001-monorepo-pnpm.md` — pnpm workspaces, not Turborepo.
- `0002-nestjs-modular-monolith.md` — single deployable, not microservices.
- `0003-detector-plugin-pattern.md` — Detector interface + provider registration.
- `0004-playwright-chromium-only.md` — single engine, no tiered fetch.
- `0005-sync-single-page-extraction.md` — no job queue in v1.
- `0006-zod-shared-contract.md` — schemas in `packages/shared`.

## Open questions

None for v1. Tracked follow-ups:

- Source-code mode (v2).
- Multi-page crawl (v2).
- Async jobs + queue (v2).
- Admin UI (v2).
- Export formats (v2).
- SSRF defense hardening via DNS resolution (v2).
- Detector accuracy tuning based on real-world samples (ongoing).
- Fixture library of 50+ representative sites for regression testing (ongoing).

## Acceptance criteria

- Auth0 login works locally (dev tenant) and prod.
- Authenticated user submits a URL and receives a structured report with 29 sections (some may be `skipped`/`error` if signal absent).
- Every detector `ok` result includes `evidence[]` with at least one entry showing the snippet that triggered detection.
- Detector failure does not block the report.
- All Zod schemas round-trip through `packages/shared`.
- E2E test passes against the dev stack.
- Docs: README, ARCHITECTURE, ADRs present and accurate.

## Error handling

| Source | Status | Body |
|---|---|---|
| Zod validation fail | 400 | `{code:'VALIDATION', message, fields:{path:msg}[]}` |
| Missing/invalid JWT | 401 | `{code:'UNAUTHENTICATED', message}` |
| Wrong role | 403 | `{code:'FORBIDDEN', message}` |
| Crawler timeout (>25s) | 504 | `{code:'CRAWLER_TIMEOUT', message, targetUrl}` |
| Crawler target 4xx/5xx | 502 | `{code:'CRAWLER_TARGET', message, targetStatus, targetUrl}` |
| Detector throws | — | Detector returns `{status:'error', error:message}`. Service never re-throws. |
| Unexpected | 500 | `{code:'INTERNAL', message:'unexpected error', hint?}` |

Global `HttpExceptionFilter` enforces the shape. No PII in errors. Target HTML is never echoed back.

## Security

- Auth0 RS256, JWKS cached 10 min, kid rotation supported.
- CORS allowlist: dev `http://localhost:5173` only; prod via env.
- Crawler navigates only to public URLs the user supplies; no auth state, no cookies sent. Browser context is fresh per request.
- Crawler strips `Authorization` from the spawned request and runs in an ephemeral context with `bypassCSP: true` only for the navigation.
- Rate limit: 10 req / user / minute (in-memory `ThrottlerGuard` v1; Redis v2).
- `targetUrl` validated to `http:`/`https:` and a public IP (SSRF guard) — v1 uses an allowlist of hostnames the user is logged in from; v2 uses DNS resolution + private-IP block.
- `helmet` middleware enabled.

## Testing

- Unit (Vitest): each detector, 5–10 fixture HTML snapshots stored under `apps/api/src/extract/detectors/__fixtures__/`.
- Zod: table-driven positive/negative per schema.
- Crawler: integration test against `httpbin.org/html` and a local static fixture server.
- E2E (Playwright): web form submit → API happy path with mocked Auth0 token.
- Coverage: 80% on `apps/api/src/extract`, 70% repo-wide.
- TDD: detectors written test-first.

## Performance budget

- p50 /extract < 8s, p95 < 22s, on a single BE pod with one Chromium instance.
- Cold-start Playwright launch: up to 3s acceptable, hidden behind a `/healthz/ready` probe.
- FE initial JS < 250KB gzipped.

## Observability

- Structured logs (pino), request id per request.
- OpenTelemetry SDK wired but exporters disabled in v1 (opt-in via `OTEL_EXPORTER_OTLP_ENDPOINT`).
- `/metrics` Prometheus endpoint (v2).

## Decisions / ADRs

Stored in `docs/decisions/`:

- `0001-monorepo-pnpm.md` — pnpm workspaces, not Turborepo.
- `0002-nestjs-modular-monolith.md` — single deployable, not microservices.
- `0003-detector-plugin-pattern.md` — Detector interface + provider registration.
- `0004-playwright-chromium-only.md` — single engine, no tiered fetch.
- `0005-sync-single-page-extraction.md` — no job queue in v1.
- `0006-zod-shared-contract.md` — schemas in `packages/shared`.

## Open questions

None for v1. Tracked follow-ups:

- Source-code mode (v2).
- Multi-page crawl (v2).
- Async jobs + queue (v2).
- Admin UI (v2).
- Export formats (v2).
- SSRF defense hardening via DNS resolution (v2).

## Acceptance criteria

- Auth0 login works locally (dev tenant) and prod.
- Authenticated user submits a URL and receives a structured report with 14 distinct sections (some may be `skipped` if signal absent).
- Detector failure does not block the report.
- All Zod schemas round-trip through `packages/shared`.
- E2E test passes against the dev stack.
- Docs: README, ARCHITECTURE, ADRs present and accurate.
