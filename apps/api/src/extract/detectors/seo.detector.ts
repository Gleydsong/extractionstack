import type { CrawledPage } from '@extractionstack/shared';
import { BaseDetector } from './detector.interface.js';

interface SeoData {
  title: string | null;
  description: string | null;
  canonical: string | null;
  robots: string | null;
  openGraph: Record<string, string>;
  twitter: Record<string, string>;
  hasSitemap: boolean | null;
  hasRobotsTxt: boolean | null;
  jsonLd: number;
}

export class SeoDetector extends BaseDetector<SeoData> {
  readonly dimension = 'seo' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<SeoData>> {
    const html = page.html;
    const openGraph: Record<string, string> = {};
    const twitter: Record<string, string> = {};
    for (const m of html.matchAll(/<meta\s+(?:property|name)="(og:[^"]+)"\s+content="([^"]*)"/gi)) {
      if (m[1]) openGraph[m[1]] = m[2] ?? '';
    }
    for (const m of html.matchAll(/<meta\s+name="(twitter:[^"]+)"\s+content="([^"]*)"/gi)) {
      if (m[1]) twitter[m[1]] = m[2] ?? '';
    }
    const hasSitemap = page.linkRel.some(
      (l) => l.rel === 'sitemap' || l.href.toLowerCase().endsWith('sitemap.xml'),
    );
    const hasRobotsTxt = page.networkLog.some(
      (n) => n.url.endsWith('/robots.txt') && (n.status ?? 0) < 400,
    );
    const jsonLd = (html.match(/application\/ld\+json/g) ?? []).length;
    return this.ok({
      title: page.meta.title ?? null,
      description: page.meta.description ?? null,
      canonical: page.meta.canonical ?? null,
      robots: page.meta.robots ?? null,
      openGraph,
      twitter,
      hasSitemap,
      hasRobotsTxt,
      jsonLd,
    });
  }
}
