import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ErrorResponseSchema, type ErrorResponse } from '@extractionstack/shared';
import { isUuidRequestId, type RequestWithId } from './request-context.js';

const PUBLIC_MESSAGES = Object.freeze({
  VALIDATION: 'Revise os dados informados e tente novamente.',
  UNAUTHENTICATED: 'Faça login para continuar.',
  FORBIDDEN: 'Você não tem permissão para realizar esta ação.',
  NOT_FOUND: 'O recurso solicitado não foi encontrado.',
  CRAWLER_TIMEOUT: 'A extração excedeu o tempo permitido.',
  CRAWLER_TARGET: 'O endereço de destino não pôde ser acessado com segurança.',
  RATE_LIMITED: 'Muitas solicitações foram enviadas. Aguarde e tente novamente.',
  CONFLICT: 'A solicitação conflita com o estado atual do recurso.',
  PAYLOAD_TOO_LARGE: 'O conteúdo enviado excede o limite permitido.',
  URL_NOT_ALLOWED: 'A URL informada não é permitida.',
  QUEUE_UNAVAILABLE: 'A fila de geração está temporariamente indisponível.',
  COST_CONSENT_REQUIRED: 'Confirme o custo máximo antes de continuar.',
  PROVIDER_UNAVAILABLE: 'O provedor está temporariamente indisponível.',
  MODEL_UNAVAILABLE: 'O modelo selecionado não está disponível.',
  INSUFFICIENT_CREDITS: 'Os créditos disponíveis são insuficientes.',
  COST_LIMIT_EXCEEDED: 'O custo estimado excede o limite confirmado.',
  INTERNAL: 'Não foi possível concluir a solicitação.',
  CRAWLER_LIMIT: 'O limite seguro da extração foi atingido.',
  CONNECTION_INVALID: 'A conexão com o provedor precisa ser atualizada.',
  DEPENDENCY_UNAVAILABLE: 'Um serviço necessário está temporariamente indisponível.',
  GUARDRAIL_REJECTED: 'A solicitação foi recusada pelas regras de segurança.',
  LLM_TIMEOUT: 'A geração excedeu o tempo permitido.',
  LLM_OUTPUT_INVALID: 'O provedor retornou uma resposta que não pôde ser validada.',
  AUTHENTICATION_FAILED: 'A conexão com o provedor precisa ser atualizada.',
  AUTHORIZATION_FAILED: 'A conexão não possui permissão para esta operação.',
  OAUTH_STATE_INVALID: 'A autorização expirou ou já foi utilizada.',
  OAUTH_REDIRECT_INVALID: 'O endereço de retorno da autorização não é permitido.',
  OAUTH_EXCHANGE_FAILED: 'Não foi possível concluir a autorização com o provedor.',
  CONNECTION_VERIFICATION_FAILED: 'Não foi possível verificar a conexão com o provedor.',
} satisfies Record<ErrorResponse['code'], string>);

type PublicCode = keyof typeof PUBLIC_MESSAGES;

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<RequestWithId>();
    const requestId = safeRequestId(req.id);

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const shaped = this.fromHttpException(body, status, requestId);
      res.status(status).json(shaped);
      return;
    }

    if (isPayloadTooLarge(exception)) {
      const body: ErrorResponse = {
        code: 'PAYLOAD_TOO_LARGE',
        message: PUBLIC_MESSAGES.PAYLOAD_TOO_LARGE,
        ...(requestId ? { requestId } : {}),
      };
      res.status(HttpStatus.PAYLOAD_TOO_LARGE).json(body);
      return;
    }

    this.logger.error(`unhandled error method=${req.method}`, {
      errorType: exception instanceof Error ? exception.name : 'UnknownError',
    });
    const body: ErrorResponse = {
      code: 'INTERNAL',
      message: PUBLIC_MESSAGES.INTERNAL,
      ...(requestId ? { requestId } : {}),
    };
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json(body);
  }

  private fromHttpException(body: unknown, status: number, requestId?: string): ErrorResponse {
    const parsed = ErrorResponseSchema.safeParse(body);
    const bodyCode = objectCode(body);
    const code = parsed.success ? parsed.data.code : (bodyCode ?? this.codeForStatus(status));
    return {
      code,
      message: PUBLIC_MESSAGES[code],
      ...(requestId ? { requestId } : {}),
    };
  }

  private codeForStatus(status: number): ErrorResponse['code'] {
    switch (status) {
      case 400:
        return 'VALIDATION';
      case 401:
        return 'UNAUTHENTICATED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'NOT_FOUND';
      case 429:
        return 'RATE_LIMITED';
      case 413:
        return 'PAYLOAD_TOO_LARGE';
      case 502:
        return 'CRAWLER_TARGET';
      case 504:
        return 'CRAWLER_TIMEOUT';
      default:
        return 'INTERNAL';
    }
  }
}

function isPayloadTooLarge(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const name = Reflect.get(value, 'name');
  const type = Reflect.get(value, 'type');
  const status = Reflect.get(value, 'status');
  const statusCode = Reflect.get(value, 'statusCode');
  return (
    name === 'PayloadTooLargeError' ||
    type === 'entity.too.large' ||
    status === HttpStatus.PAYLOAD_TOO_LARGE ||
    statusCode === HttpStatus.PAYLOAD_TOO_LARGE
  );
}

function objectCode(value: unknown): PublicCode | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const code = Reflect.get(value, 'code');
  return typeof code === 'string' && code in PUBLIC_MESSAGES ? (code as PublicCode) : null;
}

function safeRequestId(value: unknown): string | undefined {
  return isUuidRequestId(value) ? value : undefined;
}
