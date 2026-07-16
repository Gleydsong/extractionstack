# 0007 — Extrações assíncronas duráveis

- Status: Accepted
- Date: 2026-07-15
- Supersedes: ADR 0005

## Contexto

Playwright pode exceder o tempo saudável de uma conexão HTTP e consome recursos não adequados ao processo da API. O produto também precisa de histórico, retry, cancelamento e estado operacional observável.

## Decisão

Persistir jobs/relatórios no PostgreSQL, enfileirar IDs no BullMQ/Redis e executar o crawler em um worker independente. A API responde `202`; o browser faz polling com cancelamento por `AbortSignal`.

## Consequências

- API e worker escalam e falham de forma independente.
- Idempotência, ownership e transições condicionais evitam duplicação e corridas.
- Redis passa a ser dependência crítica e requer métricas/runbook.
- Consistência é eventual; a UI deve representar estados intermediários e terminais.

## Alternativas

- Request síncrono: simples, mas frágil para crawls longos e sem recuperação.
- WebSocket/SSE: útil para progresso fino, mas não substitui durabilidade e aumenta custo operacional.
