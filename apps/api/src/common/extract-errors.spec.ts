import { BadGatewayException, BadRequestException, GatewayTimeoutException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CrawlerTargetError, CrawlerTimeoutError } from '../extract/crawler/playwright-crawler.js';
import { mapExtractError } from './extract-errors.js';
import { UrlNotAllowedError } from './url-safety.js';

describe('mapExtractError', () => {
  it('maps blocked URLs to 400 VALIDATION', () => {
    expect(() =>
      mapExtractError(new UrlNotAllowedError('http://127.0.0.1', 'private or reserved IP')),
    ).toThrow(BadRequestException);
  });

  it('maps crawler timeout to 504', () => {
    expect(() =>
      mapExtractError(new CrawlerTimeoutError('https://example.com', 25000)),
    ).toThrow(GatewayTimeoutException);
  });

  it('maps crawler target errors to 502', () => {
    expect(() =>
      mapExtractError(new CrawlerTargetError('https://example.com', 404)),
    ).toThrow(BadGatewayException);
  });
});
