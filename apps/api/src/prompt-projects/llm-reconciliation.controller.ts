import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IdempotencyKeySchema, PublicIdSchema, type Auth0User } from '@extractionstack/shared';
import { z } from 'zod';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { LlmReconciliationService } from './llm-reconciliation.service';

export const LlmReconciliationCommandSchema = z
  .object({
    command: z.enum(['KNOWN_SNAPSHOT', 'CONFIRM_ACTUAL_COST', 'REVERSE_NOT_CHARGED']),
    reason: z.string().trim().min(10).max(500),
    evidence: z.string().trim().min(8).max(2_000),
    actualCostMinor: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.command === 'CONFIRM_ACTUAL_COST') !== (value.actualCostMinor !== undefined))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actualCostMinor'],
        message: 'actual cost required only for confirmation',
      });
  });
export type LlmReconciliationCommand = z.infer<typeof LlmReconciliationCommandSchema>;

@Controller('api/admin/prompt-jobs')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class LlmReconciliationController {
  constructor(
    @Inject(LlmReconciliationService) private readonly service: LlmReconciliationService,
  ) {}

  @Post(':id/reconcile')
  @HttpCode(200)
  reconcile(
    @Req() request: { user: Auth0User },
    @Param('id', new ZodValidationPipe(PublicIdSchema)) id: string,
    @Body(new ZodValidationPipe(LlmReconciliationCommandSchema)) body: LlmReconciliationCommand,
    @Headers('idempotency-key') rawKey: string | undefined,
  ) {
    return this.service.reconcile(request.user, id, body, IdempotencyKeySchema.parse(rawKey));
  }
}
