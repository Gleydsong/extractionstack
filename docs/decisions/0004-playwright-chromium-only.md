# 0004 — Playwright Chromium only

- Status: Accepted
- Date: 2026-07-14

## Context

Targets can be static or SPAs. We need to execute JavaScript to read computed styles, hydration markers, and runtime-rendered DOM. Static-only fetching (cheerio) misses SPAs; a tiered approach (try static → fall back to headless) doubles code paths.

## Decision

Use **Playwright with Chromium only** for v1. One engine, one binary, one code path.

## Consequences

- ~300MB image for the Chromium binary. Acceptable.
- Handles both static and SPA targets uniformly.
- Network capture, computed styles, and `PerformanceNavigationTiming` are all available via the same Page API.
- The crawler is a singleton (one Chromium instance per BE pod) — see ADR-0005 for the concurrency story.

## Alternatives

- **Cheerio + raw fetch first, Playwright fallback**: faster for static targets, but the detection logic (is this a SPA?) is itself heuristic and a maintenance burden. Rejected.
- **Puppeteer**: roughly equivalent to Playwright Chromium-only. Playwright wins on multi-engine extensibility (Firefox / WebKit later if needed) and the modern API.
- **Bright Data / browserless.io / hosted scrapers**: introduces a third-party dependency and a recurring cost. Not justified for v1.
