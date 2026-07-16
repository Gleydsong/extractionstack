# Arquitetura

## Visão geral

```text
React/Vite ──HTTP──> NestJS API ──Prisma──> PostgreSQL
                         │
                         └──BullMQ──> Redis ──> Worker ──> Playwright + detectores
                                                     └──Prisma──> relatório persistido
```

O request HTTP apenas valida identidade/entrada, cria um job idempotente e responde `202`. A extração pesada fica no worker; o cliente consulta o estado até um terminal e usa o histórico persistido.

## Módulos

```text
apps/api
├── auth          Auth0 RS256, dev guard e RBAC
├── extractions   controller, service, repository Prisma e adapter BullMQ
├── extract       crawler seguro, orquestração e 29 detectores
├── operations    live, ready e métricas
├── prisma        lifecycle do PrismaClient
└── common        Zod pipe, erros, SSRF, request id e logging

apps/worker
├── QueueWorkerService   consumo e lifecycle BullMQ
├── WorkerProcessor      claim, extração, validação, retry/finalização
└── WorkerJobRepository  transições atômicas e relatório

apps/web
├── auth          Auth0 ou provider local explícito
├── extractions   dashboard, polling, histórico, detalhe e cancelamento
├── extract       formulário e apresentação do relatório
└── lib           cliente HTTP com validação runtime

packages/shared
└── schemas       fonte única dos contratos Zod e tipos derivados
```

## Fluxo de dados

1. React valida a URL e envia `POST /api/extractions` com JWT e `Idempotency-Key`.
2. Guards validam identidade/papel; Zod rejeita campos desconhecidos; o service normaliza a URL.
3. O repository cria usuário/job/auditoria em transação ou retorna o job idempotente existente.
4. A API publica somente o `jobId` no BullMQ e responde `202`.
5. O worker faz claim atômico `QUEUED -> RUNNING`, executa Playwright e valida novamente o relatório.
6. Sucesso transiciona `RUNNING -> SUCCEEDED` e grava o relatório na mesma transação. Cancelamento concorrente impede essa transição.
7. O front consulta `GET /api/extractions/:id` até `SUCCEEDED`, `FAILED` ou `CANCELLED`.

## Fronteiras importantes

- O domínio de jobs depende de ports de repository/queue; Prisma e BullMQ são adapters.
- Controllers não executam crawler nem acessam Prisma diretamente.
- Detectores recebem um `CrawledPage`, não compartilham estado e falham isoladamente por seção.
- Contratos entre processos e browser são validados em runtime, não apenas pelo TypeScript.
- O worker é a fronteira de conteúdo não confiável e deve ter egress/filesystem/credenciais mínimos.

## Transições de estado

```text
QUEUED -> RUNNING -> SUCCEEDED
   │         │  └-> QUEUED (retry)
   │         └----> CANCEL_REQUESTED -> CANCELLED
   └--------------> CANCELLED
RUNNING/QUEUED ----> FAILED (tentativa final/falha de fila)
```

## Evolução dos detectores

Para adicionar uma dimensão: implemente `Detector`, registre em `detectors/registry.ts`, amplie o schema compartilhado quando necessário e cubra evidência/confiança em teste. `ExtractService` não deve mudar para cada detector.

Consulte também [maturidade operacional](operations/production-readiness.md), [modelo de segurança](security/security-model.md) e [runbook](runbooks/incident-response.md).
