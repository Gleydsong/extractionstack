import { describe, expect, it } from 'vitest';
import type { CrawledPage } from '@extractionstack/shared';
import { DETECTOR_LIST } from './registry.js';

function hasSignal(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'string') return value.length > 0 && value !== 'unknown';
  if (Array.isArray(value)) return value.some(hasSignal);
  if (value && typeof value === 'object') return Object.values(value).some(hasSignal);
  return false;
}

const richPage: CrawledPage = {
  finalUrl: 'https://example.com/dashboard',
  status: 200,
  html: `<!doctype html><html><head>
    <meta property="og:title" content="Example" />
    <style>:root{--color-primary:#3366ff}@media(min-width:768px){.grid{display:grid}}@keyframes fade{}</style>
    <script>__NEXT_DATA__={}; createStore(); gtag('config','G-1');</script>
  </head><body class="flex items-center p-4"><svg></svg><div data-scroll></div></body></html>`,
  headers: { server: 'nginx', 'x-powered-by': 'Next.js' },
  responseHeaders: { server: 'nginx' },
  networkLog: [
    {
      url: 'https://api.example.com/graphql',
      method: 'POST',
      resourceType: 'fetch',
      status: 200,
      responseHeaders: { 'content-type': 'application/json' },
    },
  ],
  cookies: [{ name: 'next-auth.session-token', value: 'redacted' }],
  meta: {
    title: 'Example',
    description: 'Example page',
    viewport: 'width=device-width, initial-scale=1',
    htmlLang: 'en',
  },
  scripts: [
    { src: 'https://cdn.example.com/_next/static/app.js' },
    { content: 'createStore(); gtag(); react-router-dom; lucide-react;' },
  ],
  stylesheets: [{ href: 'https://cdn.example.com/tailwind.css' }],
  linkRel: [{ rel: 'preload', href: 'https://cdn.example.com/app.js', as: 'script' }],
  computedStyles: [
    {
      selector: 'body',
      styles: {
        display: 'flex',
        color: 'rgb(10, 10, 10)',
        'background-color': 'rgb(255, 255, 255)',
        'font-family': 'Inter, sans-serif',
        'font-size': '16px',
        'font-weight': '400',
      },
    },
    {
      selector: 'h1',
      styles: { 'font-family': 'Inter', 'font-size': '32px', 'font-weight': '700' },
    },
  ],
  perfTiming: { domContentLoaded: 500, load: 900, firstContentfulPaint: 350 },
  fetchedAt: new Date().toISOString(),
};

describe('detector evidence contract', () => {
  it('explains every positive detection with top-level evidence', async () => {
    const missing: string[] = [];

    for (const detector of DETECTOR_LIST) {
      const result = await detector.detect(richPage);
      if (result.status === 'ok' && hasSignal(result.data) && !result.evidence?.length) {
        missing.push(result.dimension);
      }
    }

    expect(missing).toEqual([]);
  });
});
