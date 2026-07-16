# Runbook de incidentes

## Triagem inicial

1. Registre horário, impacto, versão e `x-request-id`; não copie tokens ou payloads sensíveis.
2. Consulte `/health/live` (processo), `/health/ready` (Postgres + Redis) e `/metrics`.
3. Separe falha de API, fila, worker/crawler, banco ou alvo externo.
4. Preserve logs estruturados e eventos de auditoria antes de reiniciar componentes.

## Fila crescendo

- Confirme Redis e workers ativos; compare jobs `QUEUED/RUNNING` com throughput.
- Escale workers gradualmente, respeitando CPU/memória e limites dos sites-alvo.
- Não reenvie jobs manualmente sem verificar a chave de idempotência.
- Se o crawler estiver degradado, pause consumo, preserve a fila e investigue timeout/bloqueios.

## Banco indisponível

- Tire a API de readiness; não apague volumes nem rode migration destrutiva.
- Verifique conexões, espaço, locks e última migration.
- Restaure somente de backup testado e registre RPO/RTO observado.

## Suspeita de abuso ou SSRF

- Suspenda novos jobs, preserve URL normalizada, DNS observado, request id e ator.
- Bloqueie o indicador no edge/egress, revogue credenciais potencialmente expostas e rotacione segredos.
- Não tente acessar novamente um alvo suspeito fora do worker isolado.

## Encerramento

- Confirme recuperação por E2E sintético, registre causa raiz, impacto e ações com responsável/prazo.
- Transforme a causa em teste, alerta ou guardrail antes de considerar o incidente encerrado.
