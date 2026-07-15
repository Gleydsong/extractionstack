# Architecture

## Module map

```
apps/api (NestJS)
├── AppModule
│   ├── ConfigModule            env loading
│   ├── ThrottlerModule         10 req / user / min
│   ├── PrismaModule            PrismaClient provider
│   ├── AuthModule              JwtStrategy, JwtAuthGuard, RolesGuard
│   └── ExtractModule
│       ├── ExtractController   POST /api/extract
│       ├── ExtractService      crawl + detect + merge + sort
│       ├── PlaywrightCrawler   singleton Chromium, network capture
│       └── 15 Detector classes Detector<T> interface
│           (15 v1 detectors — Responsive + Grid merged in aggregator)
└── CommonModule                ZodValidationPipe, HttpExceptionFilter

apps/web (React + Vite)
├── features/auth
│   ├── LoginPage
│   ├── CallbackPage
│   ├── RequireAuth
│   └── Header
├── features/extract
│   ├── HomePage
│   ├── UrlForm
│   ├── useExtract (hook)
│   ├── ReportView
│   └── ReportSection
└── lib / components (shared UI primitives — TBD)

packages/shared
├── schemas/
│   ├── common.ts        ErrorResponse, codes
│   ├── extract.ts       ExtractRequest, CrawledPage, DetectorResult, ExtractionReport
│   └── auth.ts          UserRole, Auth0User
└── types/
```

## Detector contract

```ts
// apps/api/src/extract/detectors/detector.interface.ts
interface Detector<TData = unknown> {
  readonly dimension: Dimension;
  detect(page: CrawledPage): Promise<DetectorResult<TData>>;
}

type DetectorResult<T> =
  | { dimension: Dimension; status: 'ok'; data: T }
  | { dimension: Dimension; status: 'skipped'; reason: string }
  | { dimension: Dimension; status: 'error'; error: string };
```

Detectors are pure functions over a `CrawledPage`. `ExtractService.runDetectorsSafely` wraps each in `try/catch`; a failing detector becomes `{status:'error'}` and the report still ships. This is the SOLID OCP/ISP point: add a 16th detector = add a class + register it in `detectors/registry.ts`. No other file changes.

## Data flow

```
React URL form
  → POST /api/extract {url} (Bearer JWT from Auth0)
  → ZodValidationPipe (rejects invalid URL → 400 VALIDATION)
  → JwtAuthGuard (Auth0 RS256 via jwks-rsa)
  → RolesGuard (user|admin)
  → ExtractController
  → ExtractService
      PlaywrightCrawler.crawl(url) → CrawledPage
      Promise.all(detectors.map(d => d.detect(page)))
      merge Responsive + Grid into single "responsive" section
      sort by DETECTOR_LIST order
  → 200 ExtractionReport
```

## Boundaries

- **No detector-to-detector calls.** Detectors take `CrawledPage` and return `DetectorResult`. They share no mutable state.
- **`packages/shared` is the only contract** between `apps/api` and `apps/web`. Schemas in Zod; types derived from schemas (`z.infer<...>`).
- **Crawler is a singleton** (`OnModuleInit`/`OnModuleDestroy`). One Chromium instance serves all requests; v2 may move to a per-request context for isolation if needed.
- **Auth0 is the only identity source.** `Prisma User` mirrors `auth0Sub` for FK; no passwords stored.

## Sequence: extract

```
User                  React              NestJS              Playwright
 |---submit URL----->|                   |                        |
 |                   |---POST /extract-->|                        |
 |                   |                   |--crawler.crawl(url)-->|
 |                   |                   |                        |--load + capture
 |                   |                   |<--CrawledPage----------|
 |                   |                   |--Promise.all(detect)->|
 |                   |                   |<--DetectorResult[]----|
 |                   |                   |--merge+sort            |
 |                   |<--200 Report------|                        |
 |<--render---------|                   |                        |
```

## Error model

`HttpExceptionFilter` always returns `ErrorResponse`:

```ts
{
  code: 'VALIDATION' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND'
      | 'CRAWLER_TIMEOUT' | 'CRAWLER_TARGET' | 'RATE_LIMITED' | 'INTERNAL',
  message: string,
  hint?: string,
  fields?: { path: string; message: string }[],
  targetStatus?: number,
  targetUrl?: string,
}
```

Detector-level errors do **not** produce HTTP errors — they appear in `ExtractionReport.sections` with `status: 'error'`. Only request-level failures (auth, validation, crawler) become HTTP errors.

## Performance budget

- p50 `/api/extract` < 8s, p95 < 22s (single BE pod, single Chromium)
- Cold Playwright launch up to 3s, hidden behind a `/healthz/ready` probe (TODO)
- FE initial JS < 250KB gzipped (Vite default config is well under)

## Adding a new detector (recipe)

1. Create `apps/api/src/extract/detectors/<name>.detector.ts` extending `BaseDetector<TData>`.
2. Set `readonly dimension = '<name>' as const;` (and add the name to `DimensionSchema` in `packages/shared`).
3. Implement `detect(page)`. Return `this.ok(data)`, `this.skipped(reason)`, or `this.error(err)`.
4. Register in `apps/api/src/extract/detectors/registry.ts` (add to `ALL`).
5. Add unit tests in `apps/api/src/extract/detectors/<name>.spec.ts`.
6. Add a fixture HTML under `apps/api/src/extract/detectors/__fixtures__/`.
7. Done — no other files change.

This is the OCP recipe the design spec promises. If you find yourself editing `ExtractService` to add a detector, the contract has broken.
