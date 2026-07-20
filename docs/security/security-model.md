# Modelo de segurança

## Controles implementados

- Autenticação Auth0 RS256 e autorização por papel; o bypass local é recusado em produção.
- Contratos Zod estritos e limitados para body, query, IDs, paginação e respostas.
- SSRF: somente HTTP(S), sem credenciais, portas perigosas, endereços privados/reservados, DNS misto ou redirecionamento para rede interna. Cada request do Chromium é revalidado.
- Crawler limitado por tempo, bytes de HTML, respostas e redirecionamentos.
- SQL injection: Prisma parametrizado; chamadas `$queryRawUnsafe` e `$executeRawUnsafe` são proibidas por teste estático. Identificadores dinâmicos passam por allowlist.
- JSON limitado a 16 KiB, rate limit, Helmet/CSP, CORS explícito e erros públicos sem stack, caminho local ou segredo.
- Idempotência por usuário e auditoria persistida para criação de jobs.
- Logs HTTP estruturados com correlação e redação de authorization, cookies, API keys e set-cookie.
- Credenciais LLM com envelope encryption, contexto de owner/provedor/versão e respostas sempre mascaradas.
- Prompt injection tratada como dado não confiável: política da plataforma tem precedência e URLs extraídas não são buscadas pelo LLM worker.
- Ownership uniforme em conexões, projetos, versões, jobs, previews, uso e créditos; versões são append-only.
- Limites por payload, token, custo, jobs ativos e orçamento diário; reserva/confirmação/reversão evitam cobrança duplicada.

## Fronteiras e riscos residuais

- DNS pode mudar depois da resolução (DNS rebinding). A interceptação de cada request reduz a janela, mas isolamento de rede do worker continua recomendado.
- A detecção analisa conteúdo não confiável. O worker deve rodar sem credenciais de nuvem, sem acesso à rede interna e com filesystem descartável.
- Rate limiting distribuído ainda depende de implantação de storage compartilhado; o limite atual do Nest é por processo.
- Imagens base e dependências precisam de varredura contínua (Dependabot/Renovate + Trivy/Grype).
- O token de métricas deve ser entregue por secret manager e `/metrics` deve permanecer em rede interna.
- OAuth depende da configuração completa; state/PKCE/callback são de uso único. OpenAI OAuth não é anunciado.
- A chave mestra deve viver em KMS/secret manager. Rotação precisa manter a versão anterior durante re-encriptação.

## Ciclo de vida de credenciais LLM

1. Gere 32 bytes com CSPRNG e armazene a forma base64 no secret manager, nunca no repositório.
2. Publique uma nova `LLM_CREDENTIAL_KEY_VERSION`, mantendo a chave anterior disponível apenas ao migrador autorizado.
3. Re-encripte em lotes pequenos, valide contagem/hash e audite falhas sem registrar plaintext.
4. Revogue a versão antiga somente após zero envelopes pendentes e backup/restauração comprovados.
5. Em comprometimento, feche o kill switch do provedor, revogue no provedor, rotacione e invalide conexões afetadas.

A matriz completa de ameaças e testes está em [llm-threat-model.md](llm-threat-model.md).

## Checklist de release

1. `NODE_ENV=production`, `AUTH_DEV_MODE=false` e origens CORS exatas.
2. Auth0 real, menor privilégio e rotação de segredos.
3. Worker sem rota para RFC1918/link-local/metadata e sem credenciais desnecessárias.
4. TLS no edge, Redis/Postgres sem portas públicas e backups criptografados.
5. `pnpm verify`, `pnpm test:e2e` e scan de imagem/dependências aprovados.
6. `LLM_PROVIDER_MODE=live`, catálogo versionado, feature flags por provedor e kill switches testados.
