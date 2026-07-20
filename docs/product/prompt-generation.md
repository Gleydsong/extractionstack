# Geração de prompts

## Objetivo e contrato público

Uma extração pertencente ao usuário pode originar um prompt universal, uma adaptação para destino específico ou um
preview limitado. O usuário combina wizard e instruções livres, revisa fonte, seções, modelo, modo, retenção e limite
de custo antes de consentir. Prompt, preview, status e erro são linguagem natural; JSON existe apenas entre camadas.

O sistema não copia código proprietário, não executa ferramentas, não navega URLs encontradas no relatório e não
cria projetos no filesystem. Evidências, confiança e limitações da extração permanecem distinguíveis no contexto.

## Três modos de credencial

| Modo                   | Responsabilidade                  | Observações                                                                                  |
| ---------------------- | --------------------------------- | -------------------------------------------------------------------------------------------- |
| OAuth                  | usuário autoriza conta compatível | Gemini somente quando callback/PKCE/revogação estão configurados; OpenAI OAuth não é exposto |
| API key do usuário     | usuário fornece chave própria     | envelope encryption, máscara, validação, rotação, revogação e exclusão                       |
| Créditos da plataforma | plataforma fornece credencial     | consentimento explícito, teto, orçamento, ledger reserva/confirma/reverte                    |

Capabilities vêm do registry: UI não presume modelos, OAuth ou preview. O modo local/CI oferece apenas `FAKE`,
`fake-deterministic-v1` e créditos fictícios sem cobrança real; nenhuma rede externa é acessada.
No bypass local, o primeiro uso concede uma única entrada auditável de créditos fictícios ao ator `dev|local`;
isso é recusado em produção e não se aplica a nenhum usuário autenticado real.

## Versionamento, retenção e exclusão

Edição, regeneração e adaptação criam versões imutáveis com vínculo à extração e hash. O padrão proposto é reter
projetos/prompts por 90 dias após última atividade, metadados de uso/ledger/auditoria pelo prazo financeiro/legal
aprovado e material transitório de composição apenas durante o job. O prazo real deve ser configurado e publicado.

Exclusão autenticada verifica ownership, revoga credenciais, cancela jobs elegíveis e elimina conteúdo conforme a
política; ledger/auditoria obrigatórios são pseudonimizados ou retidos pelo prazo justificado. Backup expira pela sua
janela normal. O atendimento registra escopo, timestamps e exceções legais sem registrar conteúdo sensível.

## Fluxo

```text
extração -> wizard/instruções -> revisão/consentimento -> job idempotente
         -> fila LLM -> guardrails/composição -> adapter -> validação
         -> versão imutável + uso/ledger -> prompt natural -> preview/adaptação
```

Consulte arquitetura, threat model e runbook do provedor antes de habilitar `live`.
