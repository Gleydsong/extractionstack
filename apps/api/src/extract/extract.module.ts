import { Module } from '@nestjs/common';
import { ExtractController } from './extract.controller.js';
import { ExtractService } from './extract.service.js';
import { PlaywrightCrawler } from './crawler/playwright-crawler.js';
import { DETECTORS } from './detectors/registry.js';

@Module({
  controllers: [ExtractController],
  providers: [ExtractService, PlaywrightCrawler, ...DETECTORS],
  exports: [ExtractService],
})
export class ExtractModule {}
