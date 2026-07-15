import { describe, expect, it } from 'vitest';
import { assertCrawlLimits, CrawlerLimitError } from './playwright-crawler.js';

describe('crawler resource limits', () => {
  const limits = { maxHtmlBytes: 1024, maxResponses: 20, maxRedirects: 2 };

  it.each([
    { htmlBytes: 1025, responseCount: 1, redirectCount: 0 },
    { htmlBytes: 100, responseCount: 21, redirectCount: 0 },
    { htmlBytes: 100, responseCount: 1, redirectCount: 3 },
  ])('rejects an extraction exceeding a bounded resource', (usage) => {
    expect(() => assertCrawlLimits(usage, limits)).toThrow(CrawlerLimitError);
  });

  it('accepts usage inside every limit', () => {
    expect(() =>
      assertCrawlLimits(
        { htmlBytes: 1024, responseCount: 20, redirectCount: 2 },
        limits,
      ),
    ).not.toThrow();
  });
});
