import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
} from '@nestjs/common';
import {
  CrawlerLimitError,
  CrawlerTargetError,
  CrawlerTimeoutError,
} from '../extract/crawler/playwright-crawler.js';
import { UrlNotAllowedError } from './url-safety.js';

export function mapExtractError(err: unknown): never {
  if (err instanceof UrlNotAllowedError) {
    throw new BadRequestException({
      code: 'URL_NOT_ALLOWED',
      message: 'target URL is not allowed',
    });
  }
  if (err instanceof CrawlerTimeoutError) {
    throw new GatewayTimeoutException({
      code: 'CRAWLER_TIMEOUT',
      message: `crawler timed out after ${err.timeoutMs}ms`,
      targetUrl: err.targetUrl,
    });
  }
  if (err instanceof CrawlerTargetError) {
    throw new BadGatewayException({
      code: 'CRAWLER_TARGET',
      message: `target returned HTTP ${err.targetStatus}`,
      targetStatus: err.targetStatus,
      targetUrl: err.targetUrl,
    });
  }
  if (err instanceof CrawlerLimitError) {
    throw new BadGatewayException({
      code: 'CRAWLER_LIMIT',
      message: 'target exceeded crawler safety limits',
    });
  }
  throw err;
}
