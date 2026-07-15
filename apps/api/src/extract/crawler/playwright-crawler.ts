import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import type { Browser, Response } from 'playwright';
import { chromium } from 'playwright';
import type { Cookie, CrawledPage, NetworkEntry } from '@extractionstack/shared';
import { assertSafeTargetUrl } from '../../common/url-safety.js';

interface InternalNetworkEntry extends NetworkEntry {
  response?: Response;
}

@Injectable()
export class PlaywrightCrawler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlaywrightCrawler.name);
  private browser: Browser | null = null;

  async onModuleInit(): Promise<void> {
    this.browser = await chromium.launch({ headless: true });
    this.logger.log('playwright chromium launched');
  }

  async onModuleDestroy(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }

  async crawl(targetUrl: string): Promise<CrawledPage> {
    if (!this.browser) throw new Error('crawler not initialized');
    const timeoutMs = Number(process.env.CRAWLER_TIMEOUT_MS ?? 25_000);
    const limits: CrawlLimits = {
      maxHtmlBytes: Number(process.env.CRAWLER_MAX_HTML_BYTES ?? 5 * 1024 * 1024),
      maxResponses: Number(process.env.CRAWLER_MAX_RESPONSES ?? 1_000),
      maxRedirects: Number(process.env.CRAWLER_MAX_REDIRECTS ?? 5),
    };

    const context = await this.browser.newContext({
      ignoreHTTPSErrors: false,
      bypassCSP: true,
    });
    let blockedRequestError: Error | null = null;
    await context.route('**/*', async (route) => {
      const requestUrl = route.request().url();
      if (!/^https?:/i.test(requestUrl)) {
        await route.continue();
        return;
      }
      try {
        await assertSafeTargetUrl(requestUrl);
        await route.continue();
      } catch (error) {
        blockedRequestError = error as Error;
        await route.abort('blockedbyclient');
      }
    });
    const page = await context.newPage();

    const net: InternalNetworkEntry[] = [];
    page.on('response', (resp: Response) => {
      const req = resp.request();
      const headers = resp.headers();
      const sizeHeader = Number(headers['content-length'] ?? 0) || undefined;
      net.push({
        url: resp.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        status: resp.status(),
        size: sizeHeader,
        responseHeaders: headers,
        contentType: headers['content-type'],
        timing: undefined,
        response: resp,
      });
    });

    try {
      const resp = await page.goto(targetUrl, {
        waitUntil: 'networkidle',
        timeout: timeoutMs,
      });
      if (blockedRequestError) throw blockedRequestError;
      const status = resp?.status() ?? 0;
      if (status >= 400) {
        throw new CrawlerTargetError(targetUrl, status);
      }
      const finalUrl = page.url();
      await assertSafeTargetUrl(finalUrl);
      const html = await page.content();
      const redirectCount = countRedirects(resp?.request());
      assertCrawlLimits(
        {
          htmlBytes: Buffer.byteLength(html, 'utf8'),
          responseCount: net.length,
          redirectCount,
        },
        limits,
      );
      const headers = resp ? resp.headers() : {};
      const meta = await this.collectMeta(page);
      const { scripts, stylesheets, linkRel } = await this.collectAssets(page);
      const computedStyles = await this.collectComputedStyles(page);
      const perfTiming = await this.collectPerfTiming(page);
      const cookies = await this.collectCookies(context);
      const networkLog = net.map((n) => this.stripResponse(n));
      const fetchedAt = new Date().toISOString();

      await context.close();

      return {
        finalUrl,
        status,
        html,
        headers,
        responseHeaders: headers,
        networkLog,
        cookies,
        meta,
        scripts,
        stylesheets,
        linkRel,
        computedStyles,
        perfTiming,
        fetchedAt,
      };
    } catch (err) {
      await context.close().catch(() => undefined);
      if (err instanceof CrawlerTargetError) throw err;
      if ((err as Error).name === 'TimeoutError') {
        throw new CrawlerTimeoutError(targetUrl, timeoutMs);
      }
      throw err;
    }
  }

  private stripResponse(n: InternalNetworkEntry): NetworkEntry {
    const { response: _r, ...rest } = n;
    void _r;
    return rest;
  }

  private async collectCookies(
    context: import('playwright').BrowserContext,
  ): Promise<Cookie[]> {
    const raw = await context.cookies();
    return raw.map((c) => ({
      name: String(c.name ?? ''),
      value: String(c.value ?? ''),
      domain: c.domain,
      path: c.path,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    }));
  }

  private async collectMeta(page: import('playwright').Page) {
    return page.evaluate(() => {
      const get = (sel: string): string | undefined =>
        document.querySelector<HTMLMetaElement>(sel)?.content;
      const canonical = document
        .querySelector<HTMLLinkElement>('link[rel="canonical"]')
        ?.href;
      return {
        title: document.title || undefined,
        description: get('meta[name="description"]'),
        canonical,
        robots: get('meta[name="robots"]'),
        viewport: get('meta[name="viewport"]'),
        charset:
          document.querySelector<HTMLMetaElement>('meta[charset]')?.getAttribute('charset') ??
          undefined,
        htmlLang: document.documentElement.lang || undefined,
      };
    });
  }

  private async collectAssets(page: import('playwright').Page) {
    return page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>('script')).map(
        (s) => ({
          src: s.src || undefined,
          type: s.type || undefined,
          content: s.src ? undefined : s.textContent ?? undefined,
        }),
      );
      const stylesheets = Array.from(
        document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
      ).map((l) => ({ href: l.href || undefined }));
      const linkRel = Array.from(document.querySelectorAll<HTMLLinkElement>('link')).map((l) => ({
        rel: l.rel,
        href: l.href,
        as: l.as || undefined,
        type: l.type || undefined,
      }));
      return { scripts, stylesheets, linkRel };
    });
  }

  private async collectComputedStyles(page: import('playwright').Page) {
    const selectors = ['body', 'h1', 'h2', 'h3', 'p', 'a', 'button', ':root'];
    return page.evaluate((sels: string[]) => {
      const props = [
        'font-family',
        'font-size',
        'font-weight',
        'line-height',
        'color',
        'background-color',
        'display',
        'gap',
      ];
      return sels.map((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { selector: sel, styles: {} as Record<string, string> };
        const cs = window.getComputedStyle(el);
        const styles: Record<string, string> = {};
        for (const p of props) {
          styles[p] = cs.getPropertyValue(p);
        }
        return { selector: sel, styles };
      });
    }, selectors);
  }

  private async collectPerfTiming(page: import('playwright').Page) {
    return page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as
        | PerformanceNavigationTiming
        | undefined;
      const paint = performance.getEntriesByType('paint');
      const fp = paint.find((p) => p.name === 'first-paint')?.startTime;
      const fcp = paint.find((p) => p.name === 'first-contentful-paint')?.startTime;
      return {
        navigationStart: nav?.startTime,
        domContentLoaded: nav?.domContentLoadedEventEnd,
        load: nav?.loadEventEnd,
        firstPaint: fp,
        firstContentfulPaint: fcp,
      };
    });
  }
}

export interface CrawlUsage {
  htmlBytes: number;
  responseCount: number;
  redirectCount: number;
}

export interface CrawlLimits {
  maxHtmlBytes: number;
  maxResponses: number;
  maxRedirects: number;
}

export class CrawlerLimitError extends Error {
  constructor(public readonly limit: keyof CrawlLimits) {
    super(`crawler resource limit exceeded: ${limit}`);
    this.name = 'CrawlerLimitError';
  }
}

export function assertCrawlLimits(usage: CrawlUsage, limits: CrawlLimits): void {
  if (usage.htmlBytes > limits.maxHtmlBytes) throw new CrawlerLimitError('maxHtmlBytes');
  if (usage.responseCount > limits.maxResponses) throw new CrawlerLimitError('maxResponses');
  if (usage.redirectCount > limits.maxRedirects) throw new CrawlerLimitError('maxRedirects');
}

function countRedirects(request: import('playwright').Request | undefined): number {
  let count = 0;
  let current = request?.redirectedFrom() ?? null;
  while (current) {
    count += 1;
    current = current.redirectedFrom();
  }
  return count;
}

export class CrawlerTimeoutError extends Error {
  constructor(
    public readonly targetUrl: string,
    public readonly timeoutMs: number,
  ) {
    super(`crawler timeout after ${timeoutMs}ms for ${targetUrl}`);
  }
}

export class CrawlerTargetError extends Error {
  constructor(
    public readonly targetUrl: string,
    public readonly targetStatus: number,
  ) {
    super(`target ${targetUrl} returned ${targetStatus}`);
  }
}
