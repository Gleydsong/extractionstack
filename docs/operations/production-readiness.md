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
| LLM/custos      |     3 | fila dedicada, double, ledger, limites, reconciliação e métricas            | pilot, alertas calibrados e game day de provedor  |

## SLOs propostos

- API de criação/listagem: 99,9% mensal, p95 abaixo de 500 ms sem contar execução do crawler.
- Aceitação da fila: 99,5% mensal.
- 95% dos jobs válidos iniciam em até 60 s e terminam em até 120 s.
- RPO de Postgres: 15 min; RTO: 60 min, a confirmar em exercício de restauração.
- Geração LLM: disponibilidade mensal 99,5%; p95 inicia em 30 s e termina em 90 s quando o provedor está saudável.
- Segurança financeira: zero exposição de credencial e zero cobrança duplicada; degradação material alerta em 5 min.

## Sinais e alertas LLM

Dashboard mínimo: fila por estado/idade, throughput e duração, falhas/retries por categoria e provedor,
kill switches, DLQ/reconciliação, tokens/custo por modo, guardrails e violações do ledger. Labels jamais incluem
owner, URL, prompt, instrução, credencial ou mensagem livre. Regras iniciais estão em `ops/prometheus/llm-alerts.yml`.

Circuit breaker automático/dinâmico não faz parte da implementação atual. Planeje-o como evolução futura com estado
compartilhado, limiares, half-open, métricas e testes próprios; até lá, operação usa somente kill switches explícitos.

## Release e rollback

1. Faça backup, prove restore em ambiente descartável e aplique migrations backward-compatible.
2. Suba API/worker com geração desabilitada; valide readiness, métricas e double determinístico.
3. Pilote por coorte: créditos internos, API key, Gemini OAuth, wizard/preview; limite usuário, custo global e concorrência.
4. Habilite cada provedor/modo por flag independente. O kill switch bloqueia novos jobs, preservando leitura e finalização segura.
5. Para rollback, desabilite submissões, drene/cancele conforme política, reverta imagem e nunca reverta migration destrutivamente.

Backups incluem Postgres e metadados do ledger/auditoria; segredos/KMS seguem backup separado. Redis/fila não é fonte
única de verdade: reconciliação repõe jobs persistidos. Restore valida contagens, ownership, versões, saldo e invariantes.

Flags iniciais: `LLM_PROMPT_GENERATION_ENABLED`, `LLM_PROVIDER_OPENAI_ENABLED`,
`LLM_PROVIDER_GEMINI_ENABLED` e `LLM_PLATFORM_CREDITS_ENABLED`. A primeira e as flags de provedor são kill switches
de submissão/capability; créditos devem permanecer desligados até orçamento, saldo e reconciliação estarem validados.

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
- Exercitar rotação/revogação de credenciais, outage, backlog, stuck job, replay e anomalia de custo.

### P2 maturidade contínua

- Testes de caos para Redis/Postgres/worker, canary e error budgets.
- Revisões periódicas de threat model, restore drill e game day de incidentes.
