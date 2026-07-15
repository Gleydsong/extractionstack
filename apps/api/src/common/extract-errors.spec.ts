import { BadGatewayException, BadRequestException, GatewayTimeoutException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CrawlerTargetError, CrawlerTimeoutError } from '../extract/crawler/playwright-crawler.js';
import { mapExtractError } from './extract-errors.js';
import { UrlNotAllowedError } from './url-safety.js';

describe('mapExtractError', () => {
  it('maps blocked URLs to a sanitized 400 URL_NOT_ALLOWED', () => {
    try {
      mapExtractError(
        new UrlNotAllowedError('http://169.254.169.254/latest', 'metadata IP detected'),
      );
      throw new Error('expected mapExtractError to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual({
        code: 'URL_NOT_ALLOWED',
        message: 'target URL is not allowed',
      });
    }
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
