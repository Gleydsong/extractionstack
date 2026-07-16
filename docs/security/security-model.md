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

## Fronteiras e riscos residuais

- DNS pode mudar depois da resolução (DNS rebinding). A interceptação de cada request reduz a janela, mas isolamento de rede do worker continua recomendado.
- A detecção analisa conteúdo não confiável. O worker deve rodar sem credenciais de nuvem, sem acesso à rede interna e com filesystem descartável.
- Rate limiting distribuído ainda depende de implantação de storage compartilhado; o limite atual do Nest é por processo.
- Imagens base e dependências precisam de varredura contínua (Dependabot/Renovate + Trivy/Grype).
- O token de métricas deve ser entregue por secret manager e `/metrics` deve permanecer em rede interna.

## Checklist de release

1. `NODE_ENV=production`, `AUTH_DEV_MODE=false` e origens CORS exatas.
2. Auth0 real, menor privilégio e rotação de segredos.
3. Worker sem rota para RFC1918/link-local/metadata e sem credenciais desnecessárias.
4. TLS no edge, Redis/Postgres sem portas públicas e backups criptografados.
5. `pnpm verify`, `pnpm test:e2e` e scan de imagem/dependências aprovados.
