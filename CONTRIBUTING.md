# Contributing

## Setup

```bash
pnpm install
docker compose up -d
cp .env.example .env
pnpm prisma:generate
pnpm --filter @extractionstack/api exec playwright install chromium
```

## Development

```bash
pnpm dev               # api + web
pnpm dev:api           # backend only
pnpm dev:web           # frontend only
```

## Testing

```bash
pnpm test              # unit tests
pnpm typecheck         # typecheck
pnpm lint              # lint
```

## Adding a new detector

See `docs/ARCHITECTURE.md#adding-a-new-detector-recipe`.

1. Add the dimension name to `packages/shared/src/schemas/extract.ts` (`DimensionSchema`).
2. Create `apps/api/src/extract/detectors/<name>.detector.ts` extending `BaseDetector`.
3. Register it in `apps/api/src/extract/detectors/registry.ts`.
4. Add a unit test in `apps/api/src/extract/detectors/<name>.spec.ts`.
5. Add a fixture HTML under `apps/api/src/extract/detectors/__fixtures__/` if the detector needs a realistic page.

Test first. The plugin pattern is designed for TDD: each detector is a pure function over `CrawledPage`, no I/O.

## Code style

- TypeScript strict mode. No `any`.
- SOLID: prefer small, single-responsibility units.
- YAGNI: no speculative abstractions. Add when needed.
- KISS: no premature optimization. Measure first.
- DRY: the contract lives in `packages/shared`. Don't duplicate.
- No comments unless they're load-bearing (e.g. explaining a non-obvious decision in an ADR or in a `// SAFETY` line). Code should read as documentation.

## Commit messages

Use Conventional Commits. Examples:

- `feat(extract): add icons detector`
- `fix(crawler): handle timeout as CrawlerTimeoutError`
- `docs(arch): update detector recipe`
- `chore(deps): bump playwright to 1.42`

## Pull request checklist

- [ ] Tests added for new behavior
- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` clean
- [ ] `pnpm test` clean
- [ ] `docs/ARCHITECTURE.md` updated if module boundaries changed
- [ ] New ADR under `docs/decisions/` for any new architectural decision
