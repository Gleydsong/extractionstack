# Threat model da geração LLM

## Ativos, fronteiras e adversários

Ativos: credenciais/OAuth, extrações, prompts/version history, ledger/créditos, identidade e auditoria. Fronteiras:
browser/API, API/Postgres/Redis, fila/LLM worker e adapter/provedor externo. Entrada do usuário, conteúdo extraído e
resposta do provedor são não confiáveis. Consideramos usuário malicioso, site analisado hostil, credencial vazada,
provedor degradado e erro operacional; não assumimos controle do provedor.

## Controles e testes

| Ameaça                   | Controle                                                        | Regressão automatizada                                             |
| ------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| SQL injection            | Zod estrito, Prisma parametrizado, proibição de raw unsafe      | security guard scan + payloads em IDs/texto/filtros/cursor         |
| Prompt injection         | camadas de política, evidência como dado, detector/ação bounded | unitários de guardrail + E2E com instrução hostil na extração      |
| XSS armazenado/refletido | React escaping, sem HTML bruto, headers CSP                     | E2E payload inerte em prompt/erro/preview                          |
| IDOR                     | owner scope em toda consulta/mutação e not-found uniforme       | API/E2E cross-user para conexão/projeto/versão/job/preview/crédito |
| CSRF/OAuth               | state/nonce/PKCE, redirect allowlist, callback single-use       | callback replay/state inválido/account mismatch                    |
| Segredos                 | envelope encryption, máscara, redação, campos não enumeráveis   | leak suite em API/log/metrics/snapshot/erro/browser                |
| Abuso/custo              | rate/concurrency/token/payload/cost/daily budget + consent      | limites e bypass; orçamento/insufficient credit                    |
| SSRF como dado           | LLM worker não busca URL de evidência/instrução                 | double de fetch confirma zero requests derivados                   |
| Cobrança duplicada       | idempotência durável + ledger append-only + reconciliação       | enqueue/retry/callback/resposta duplicados confirmam uma cobrança  |
| Supply chain/egress      | lockfile, scan/SBOM planejado, adapter allowlist/HTTPS          | CI lock + static endpoints; policy de egress em staging            |

## Riscos residuais

Um provedor processa conteúdo enviado conforme seu contrato; minimização e acordo de dados são pré-requisitos.
Prompt injection não é “resolvida” por uma string: defesa combina isolamento de ferramentas, ausência de fetch,
validação, limites e revisão humana. Métrica agregada não substitui auditoria. Egress deny-by-default, KMS gerenciado,
scan de imagem, DLP e testes de restore/caos permanecem gates de produção.
