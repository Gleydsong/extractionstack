# Maturidade operacional

## Estado atual

Escala: 1 ad hoc, 3 operacional controlado, 5 operação madura e continuamente otimizada.

| Dimensão        | Nível | Evidência atual                                                             | Próximo passo                                     |
| --------------- | ----: | --------------------------------------------------------------------------- | ------------------------------------------------- |
| Segurança       |     4 | Auth/RBAC, contratos estritos, SSRF profundo, guard SQLi, limites e redação | egress deny-by-default e scan contínuo            |
| Confiabilidade  |     3 | fila durável, idempotência, retry, cancelamento e shutdown                  | DLQ/replay administrado e testes de caos          |
| Observabilidade |     3 | request id, logs JSON, live/ready e Prometheus                              | dashboard, tracing e alertas por SLO              |
| Entrega         |     3 | build reproduzível, Docker Compose e CI com E2E                             | registry, assinatura/SBOM e promoção staging-prod |
| Dados           |     3 | migrations, integridade, ownership e auditoria                              | backup/restore automatizado e retenção formal     |
| Incidentes      |     2 | runbook inicial e sinais diagnósticos                                       | on-call, exercícios e postmortem sem culpa        |

## SLOs propostos

- API de criação/listagem: 99,9% mensal, p95 abaixo de 500 ms sem contar execução do crawler.
- Aceitação da fila: 99,5% mensal.
- 95% dos jobs válidos iniciam em até 60 s e terminam em até 120 s.
- RPO de Postgres: 15 min; RTO: 60 min, a confirmar em exercício de restauração.

## Plano de evolução

### P0 antes de produção pública

- Isolar egress do worker, fechar Postgres/Redis à rede pública e usar secret manager.
- Automatizar backup e provar restauração em ambiente descartável.
- Criar dashboards/alertas para erro 5xx, readiness, tamanho/idade da fila, falha e duração de jobs.
- Executar teste de carga e definir capacidade/concurrency segura.

### P1 após estabilização

- DLQ com replay auditado, tracing OpenTelemetry e rate limit distribuído no Redis/edge.
- SBOM, assinatura e scan de imagem; deploy imutável com rollback ensaiado.
- Política de retenção/eliminação de relatórios e auditoria.

### P2 maturidade contínua

- Testes de caos para Redis/Postgres/worker, canary e error budgets.
- Revisões periódicas de threat model, restore drill e game day de incidentes.
