# Runbook de provedores LLM

## Preparação e sinais

Exija dashboard de fila/idade, sucesso/falha/latência por provedor, DLQ/reconciliação, uso/custo,
guardrails, credenciais e invariantes. Confirme API ready, heartbeat recente `llm-worker:v1:heartbeat`, Postgres,
Redis e catálogo. Nunca faça chamada paga como health check.

O runtime atual aplica kill switches globais e por provedor tanto na submissão quanto antes da chamada do adapter.
Circuit breaker automático/dinâmico ainda não foi implementado; `circuitBreakerOpen` permanece parte do contrato para
evolução futura, mas não deve ser tratado como controle operacional ativo.

## Backlog ou worker indisponível

1. Pause novas submissões pela flag global; preserve leituras.
2. Confira heartbeat, DB/Redis, queue registration, CPU/memória e idade, não apenas profundidade.
3. Reinicie uma instância por vez. Escale dentro de quota/concurrency do provedor.
4. Se persistência tem job sem fila, deixe o sweeper reconciliar; não publique IDs à mão.
5. Reduza backlog por canário e observe retry, custo e erro antes de drenar.

## Outage ou job travado

- Abra kill switch apenas para o provedor afetado. Não faça fallback de API key/OAuth para crédito da plataforma.
- Classifique transient/permanent/ambiguous. Retry somente transient e dentro do limite idempotente.
- Job ativo além do timeout: confirme attempt/lease e consulta segura ao provedor quando disponível; estado ambíguo vai
  para reconciliação, nunca para cobrança ou retry cego.
- Reabilite o kill switch por canário após recuperação; desabilite novamente se erro/latência exceder o limiar.

## DLQ e replay

Replay requer papel administrativo, seleção explícita, causa corrigida, motivo, idempotency key e auditoria. Antes,
confirme se houve resposta/cobrança externa. Depois, valide uma única versão, usage e transação de ledger. Faça lotes
pequenos e pare ao primeiro desvio.

## Billing

Compare estimativa, máximo consentido, usage confirmado e `pricingVersion`. Anomalia: desabilite créditos, preserve
ledger e reconcilie com fatura. Reserva sem execução reverte; sucesso confirma; resposta ambígua aguarda evidência.
Nunca altere saldo diretamente. Violação de invariantes é P0.

## Credencial e chave de criptografia

Comprometimento: kill switch, revogação externa, estado local `REVOKED`, rotação e análise sem plaintext. Rotação da
chave mestra: nova versão no KMS, dual-read temporário, re-encriptação auditada, verificação de zero pendências e só
então revogação antiga. Falha parcial pausa o lote e mantém versão anterior disponível.

## Release, smoke e rollback

PR/CI usa `fake`. Smoke real somente em ambiente protegido, fora de PR, credencial efêmera de menor privilégio,
`RUN_REAL_PROVIDER_SMOKE=true` e teto de 1 unidade minor. Habilite coorte pequena e limites globais. Rollback desliga
novos jobs, preserva leitura, processa terminais seguros e reverte imagem; migration permanece compatível.

O comando `pnpm test:smoke:providers` exige também `LLM_SMOKE_PROVIDER` (`OPENAI` ou `GEMINI`),
`LLM_SMOKE_CREDENTIAL` e `LLM_SMOKE_MAX_COST_MINOR_UNITS`. Ele consulta apenas metadata no host HTTPS fixo, sem
geração; não registre o ambiente nem a saída do shell que contenha a credencial.
