import { describe, it, expect } from 'vitest';
import {
  ExtractRequestSchema,
  ErrorResponseSchema,
  CrawledPageSchema,
  ExtractionReportSchema,
} from '@extractionstack/shared';

describe('ExtractRequestSchema', () => {
  it('accepts valid https URL', () => {
    const r = ExtractRequestSchema.safeParse({ url: 'https://example.com' });
    expect(r.success).toBe(true);
  });
  it('rejects non-URL', () => {
    const r = ExtractRequestSchema.safeParse({ url: 'not-a-url' });
    expect(r.success).toBe(false);
  });
  it('rejects ftp', () => {
    const r = ExtractRequestSchema.safeParse({ url: 'ftp://example.com' });
    expect(r.success).toBe(false);
  });
  it('rejects unknown fields and oversized URLs', () => {
    expect(
      ExtractRequestSchema.safeParse({ url: 'https://example.com', role: 'admin' }).success,
    ).toBe(false);
    expect(
      ExtractRequestSchema.safeParse({ url: `https://example.com/${'x'.repeat(2049)}` }).success,
    ).toBe(false);
  });
});

describe('ErrorResponseSchema', () => {
  it.each([
    'COST_CONSENT_REQUIRED',
    'PROVIDER_UNAVAILABLE',
    'MODEL_UNAVAILABLE',
    'INSUFFICIENT_CREDITS',
    'COST_LIMIT_EXCEEDED',
  ])('accepts the prompt API public error code %s', (code) => {
    expect(
      ErrorResponseSchema.safeParse({ code, message: 'Actionable natural-language message' })
        .success,
    ).toBe(true);
  });

  it('validates the canonical error shape', () => {
    const r = ErrorResponseSchema.safeParse({
      code: 'CRAWLER_TIMEOUT',
      message: 'timed out',
      targetUrl: 'https://example.com',
    });
    expect(r.success).toBe(true);
  });
  it('accepts operational security error codes', () => {
    expect(
      ErrorResponseSchema.safeParse({
        code: 'URL_NOT_ALLOWED',
        message: 'target rejected',
        requestId: 'cb6d0478-a915-4d09-bde4-b6270d677e6a',
      }).success,
    ).toBe(true);
  });
});

describe('CrawledPageSchema', () => {
  it('round-trips a minimal page', () => {
    const obj = {
      finalUrl: 'https://example.com',
      status: 200,
      html: '<html></html>',
      headers: {},
      responseHeaders: {},
      networkLog: [],
      meta: {},
      scripts: [],
      stylesheets: [],
      linkRel: [],
      computedStyles: [],
      fetchedAt: new Date().toISOString(),
    };
    expect(CrawledPageSchema.safeParse(obj).success).toBe(true);
  });
});

describe('ExtractionReportSchema', () => {
  it('accepts an empty sections map', () => {
    const r = ExtractionReportSchema.safeParse({
      url: 'https://example.com',
      finalUrl: 'https://example.com',
      fetchedAt: new Date().toISOString(),
      durationMs: 100,
      sections: {},
    });
    expect(r.success).toBe(true);
  });
});
