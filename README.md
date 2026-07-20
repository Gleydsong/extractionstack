# ExtractionStack

Aplicação full-stack que recebe uma URL pública, executa uma análise assíncrona em Chromium e persiste um relatório técnico com evidências sobre front-end, back-end, design, performance, segurança e infraestrutura. Cada conclusão é classificada como confirmada, altamente provável, provável, não identificada ou não aplicável.

## Arquitetura

- React/Vite: dashboard, histórico, polling e cancelamento.
- NestJS: autenticação/RBAC, contratos Zod, ownership, idempotência e API de jobs.
- BullMQ/Redis: fila, retry e concorrência controlada.
- Worker/Playwright: navegação isolável, guardrails SSRF e 29 detectores.
- LLM worker/BullMQ: geração, adaptação e preview por adapters; provedor falso determinístico por padrão.
- PostgreSQL/Prisma: jobs, relatórios e auditoria.
- Operação: logs JSON correlacionados, health/readiness, métricas Prometheus, CI e Docker Compose.

## Relatório de investigação

O relatório reúne reconhecimento geral, tabela de tecnologias, frontend, design system, backend observável, APIs, autenticação e segurança, CMS, infraestrutura, integrações, performance, SEO, acessibilidade, diagrama Mermaid, estrutura estimada, riscos, recomendações, matriz final de confiança e inventário técnico das evidências.

A investigação é passiva e limitada a recursos públicos carregados pela URL analisada. Banco de dados, serviços internos, código-fonte e configuração privada permanecem como `não identificado` quando não existe evidência direta; o sistema não tenta autenticar, explorar vulnerabilidades ou contornar controles de acesso.

## Subir localmente

Modo mais simples, com toda a stack em containers:

```bash
docker compose up --build -d
docker compose ps
```

Abra `http://localhost:8080`. API: `http://localhost:3001`; liveness: `/health/live`; readiness: `/health/ready`; métricas: `/metrics`.

Para desenvolvimento com Node local:

```bash
pnpm install
docker compose up -d postgres redis
cp .env.example .env
pnpm prisma:generate
pnpm prisma:migrate
pnpm --filter @extractionstack/api exec playwright install chromium
pnpm dev
```

O bypass `AUTH_DEV_MODE=true` existe apenas para desenvolvimento e é rejeitado quando `NODE_ENV=production`.
O ambiente local usa `LLM_PROVIDER_MODE=fake`: nenhuma chamada paga ou externa é feita. A geração aceita
instruções guiadas e livres e sempre apresenta prompt, preview e erros em linguagem natural, nunca JSON interno.

## API assíncrona

- `POST /api/extractions` — cria job; exige `Idempotency-Key`.
- `GET /api/extractions` — histórico paginado do usuário.
- `GET /api/extractions/:id` — estado e relatório persistido.
- `POST /api/extractions/:id/cancel` — solicita cancelamento.

## Qualidade

```bash
pnpm verify       # lint + typecheck + unitários + builds
pnpm test:e2e     # contrato HTTP Nest + fluxos Chromium
```

O smoke de provedor real é uma ação protegida de release, nunca de PR: exige
`RUN_REAL_PROVIDER_SMOKE=true` e `LLM_SMOKE_MAX_COST_MINOR_UNITS` entre 0 e 1.

## Documentação operacional

- [Maturidade e roadmap](docs/operations/production-readiness.md)
- [Modelo de segurança](docs/security/security-model.md)
- [Contrato do relatório e cobertura](docs/product/investigation-report.md)
- [Geração de prompts](docs/product/prompt-generation.md)
- [Operação de provedores LLM](docs/operations/llm-provider-runbook.md)
- [Threat model LLM](docs/security/llm-threat-model.md)
- [Runbook de incidentes](docs/runbooks/incident-response.md)
- [Arquitetura](docs/ARCHITECTURE.md)

## Estrutura

```text
apps/api       API NestJS
apps/worker    consumidor BullMQ + crawler
apps/llm-worker consumidor dedicado da fila de prompts
apps/web       React/Vite
packages/llm-core adapters, composição, guardrails e pricing
packages/shared contratos Zod e tipos
e2e            testes browser Playwright
ops            configuração de runtime
```

Licença: UNLICENSED — projeto interno.
