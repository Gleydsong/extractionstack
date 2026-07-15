import { Module } from '@nestjs/common';
import { ExtractService } from './extract.service.js';
import { PlaywrightCrawler } from './crawler/playwright-crawler.js';
import { DETECTORS } from './detectors/registry.js';

@Module({
  providers: [ExtractService, PlaywrightCrawler, ...DETECTORS],
  exports: [ExtractService],
})
export class ExtractModule {}
