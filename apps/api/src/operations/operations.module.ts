import { Module } from '@nestjs/common';
import { OperationsController } from './operations.controller.js';
import { OperationsService } from './operations.service.js';
import { AiConnectionsModule } from '../ai-connections/ai-connections.module.js';

@Module({
  imports: [AiConnectionsModule],
  controllers: [OperationsController],
  providers: [OperationsService],
})
export class OperationsModule {}
