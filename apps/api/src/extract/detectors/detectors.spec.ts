import { describe, it, expect } from 'vitest';
import { CssFrameworkDetector } from './css-framework.detector.js';
import { PaletteDetector } from './palette.detector.js';
import { SeoDetector } from './seo.detector.js';
import type { CrawledPage } from '@extractionstack/shared';

function page(html: string, overrides: Partial<CrawledPage> = {}): CrawledPage {
  return {
    finalUrl: 'https://example.com',
    status: 200,
    html,
    headers: {},
    responseHeaders: {},
    networkLog: [],
    cookies: [],
    meta: { title: 'T', description: 'D' },
    scripts: [],
    stylesheets: [],
    linkRel: [],
    computedStyles: [],
    perfTiming: {},
    fetchedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('CssFrameworkDetector', () => {
  it('detects tailwind by class signatures', async () => {
    const html = '<div class="flex items-center p-4 text-lg"></div>';
    const result = await new CssFrameworkDetector().detect(page(html));
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.primary).toBe('tailwind');
      expect(result.data.detected).toContain('tailwind');
    }
  });

  it('returns empty when no signature matches', async () => {
    const html = '<div class="my-custom-class"></div>';
    const result = await new CssFrameworkDetector().detect(page(html));
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.detected).toEqual([]);
      expect(result.data.primary).toBeNull();
    }
  });
});

describe('PaletteDetector', () => {
  it('collects background and text colors from computed styles', async () => {
    const p = page('<html></html>', {
      computedStyles: [
        { selector: 'body', styles: { 'background-color': 'rgb(255, 255, 255)', color: 'rgb(0, 0, 0)' } },
        { selector: 'a', styles: { 'background-color': 'rgba(0, 0, 0, 0)', color: 'rgb(0, 0, 238)' } },
      ],
    });
    const result = await new PaletteDetector().detect(p);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.backgroundColors).toContain('rgb(255, 255, 255)');
      expect(result.data.textColors).toContain('rgb(0, 0, 0)');
      expect(result.data.textColors).toContain('rgb(0, 0, 238)');
    }
  });
});

describe('SeoDetector', () => {
  it('parses open graph and twitter meta', async () => {
    const html = `
      <html><head>
        <meta property="og:title" content="T" />
        <meta name="twitter:card" content="summary" />
      </head></html>
    `;
    const result = await new SeoDetector().detect(page(html));
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.openGraph['og:title']).toBe('T');
      expect(result.data.twitter['twitter:card']).toBe('summary');
    }
  });
});
