# Contrato do relatório de investigação

## Objetivo

O ExtractionStack investiga uma URL pública com Chromium e produz um relatório técnico reproduzível. O objetivo padrão é compreender como a interface observada foi construída, quais tecnologias possuem evidência pública, como ela se comunica com serviços externos e quais riscos e limitações podem ser avaliados de forma passiva.

O produto não executa pentest ativo. Não tenta login, bypass, brute force, injeção, enumeração agressiva ou acesso a recursos privados.

## Modelo de confiança

| Valor | Critério |
| --- | --- |
| `confirmed` | Evidência direta e específica coletada na execução. |
| `highly_probable` | Múltiplas evidências consistentes, sem confirmação inequívoca. |
| `probable` | Indícios limitados que sustentam uma hipótese. |
| `not_identified` | Nenhuma evidência pública suficiente. Não significa ausência. |
| `not_applicable` | O item foi avaliado e não faz parte do alvo observado. |

Cada descoberta contém nome, categoria, resultado, locais, confiança, função provável, limitações e evidências. Valores de cookies sensíveis, credenciais, parâmetros de query e headers de autenticação não integram o relatório.

## Cobertura funcional

| Área solicitada | Cobertura atual | Fonte principal |
| --- | --- | --- |
| Reconhecimento geral | Tipo e características observáveis da página | DOM, URL final e recursos carregados |
| Frontend | framework, linguagem detectável, CSS, componentes, estado, rotas e renderização | DOM, scripts, stylesheets e assinaturas runtime |
| Design system | fontes, cores, tokens, responsividade, ícones, transições e animações | CSS computado, variáveis, folhas de estilo e DOM |
| Mídia | formatos, imagens responsivas, lazy loading e vídeo | elementos e requisições públicas |
| Acessibilidade | idioma, headings, imagens alternativas e sinais semânticos | DOM renderizado |
| SEO | metadados e sinais técnicos públicos | `head`, DOM e recursos descobertos |
| PWA/navegador | manifest, service worker e sinais de armazenamento | DOM e runtime público |
| Backend/API | tecnologia e endpoints somente quando expostos | headers e requisições observadas |
| Autenticação | provedor e fluxo somente quando existem assinaturas públicas | scripts, cookies sem valores e requisições |
| Banco, filas e armazenamento | confirmado apenas com evidência direta | respostas e recursos públicos |
| CMS | assinaturas públicas conhecidas ou `not_identified` | URLs, DOM, scripts e recursos |
| Integrações | analytics, monitoramento, pagamentos e terceiros observados | domínios e scripts carregados |
| Infraestrutura | CDN, cloud, proxy e container apenas com sinais públicos | headers, hosts e recursos |
| Segurança | HTTPS, headers, cookies sem valores e exposição pública | resposta principal e metadados passivos |
| Performance | métricas e gargalos observáveis na carga analisada | timings, recursos, DOM e detectores |

## Estrutura entregue

1. Resumo executivo.
2. Tabela geral de tecnologias.
3. Arquitetura de frontend.
4. Design system.
5. Arquitetura de backend.
6. APIs e comunicação.
7. Autenticação e segurança.
8. CMS e conteúdo.
9. Infraestrutura e deploy.
10. Integrações externas.
11. Performance, SEO e acessibilidade.
12. Diagrama arquitetural Mermaid.
13. Estrutura estimada do projeto, sempre marcada como reconstrução.
14. Riscos e limitações.
15. Recomendações priorizadas.
16. Conclusão sem promover hipóteses a fatos.
20. Matriz final de confiança com as 14 categorias obrigatórias.
21. Evidências técnicas coletadas.

Os números 17 a 19 e 22 da especificação original descrevem conteúdo, formato e resultado esperado; eles são incorporados às seções acima e não duplicados na interface.

## Limites conhecidos

- A versão atual analisa uma URL por job; não realiza descoberta recursiva de um site inteiro.
- Áreas autenticadas e rotas que não foram abertas não são inspecionadas.
- Minificação e transpilação podem impedir a identificação da linguagem ou dos nomes internos.
- A interface pública raramente permite confirmar banco, filas, topologia interna ou provedor do backend.
- A estrutura de pastas é uma proposta de reconstrução baseada nas evidências, nunca uma cópia presumida do projeto original.
- Resultados representam a página e o instante da execução; conteúdo dinâmico e testes A/B podem alterar as evidências.

## Evolução planejada

Para ampliar a profundidade sem reduzir a confiabilidade: crawling multi-rota com limites explícitos, captura opcional de Lighthouse, comparação entre execuções, importação autorizada de repositório e um modo de infraestrutura que consuma configurações fornecidas pelo proprietário. Cada modo deve manter proveniência e confiança separadas das evidências públicas.
