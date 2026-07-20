# ExtractionStack Product Register

## Register

product

## Users

- Desenvolvedores e arquitetos que precisam compreender sistemas públicos com evidências verificáveis.
- Times técnicos, de segurança e de produto que transformam uma extração em documentação, requisitos ou prompts de criação.
- Usuários autenticados que conectam provedores de LLM por credencial própria, OAuth compatível ou créditos da plataforma.

## Product Purpose

ExtractionStack investiga aplicações web de forma passiva e autorizada, organiza evidências técnicas com níveis explícitos de confiança e apresenta o resultado em linguagem natural. A extensão de geração transforma uma extração pertencente ao usuário em prompts reutilizáveis para diferentes tipos de criação, sem copiar código proprietário e sem executar ferramentas autônomas.

## Brand Personality

Técnica, confiável, didática, sóbria e transparente. Interface deve parecer instrumento de engenharia: evidencia estado, origem, custo, risco e próxima ação sem dramatização visual.

## Anti-references

- Conclusões opacas que escondem evidência, confiança ou limitações.
- Estética de invasão, terminal cenográfico ou linguagem agressiva de exploração.
- Dashboards decorativos, excesso de cards, gradientes de texto e efeitos de vidro.
- Interface de agente autônomo que sugira execução de código, filesystem, navegação ou criação completa de projetos.
- Credenciais, respostas brutas de provedores ou JSON interno expostos ao usuário.

## Design Principles

1. Evidência antes de afirmação: origem, confiança e limitação permanecem legíveis.
2. Linguagem natural primeiro: estruturas internas servem validação, nunca viram saída crua.
3. Divulgação progressiva: fluxo principal simples; detalhes técnicos disponíveis sob demanda.
4. Estado explícito: carregamento, validação, revogação, custo, consentimento e falha têm mensagens inequívocas.
5. Segurança visível sem alarmismo: segredos mascarados, ações destrutivas confirmadas e limites explicados.
6. Consistência antes de novidade: reutilizar tokens, componentes e padrões existentes quando adequados.
7. Teclado primeiro: ordem de foco, rótulos e mensagens de status fazem parte do fluxo principal.

## Accessibility and Inclusion

- Meta WCAG 2.2 AA.
- Contraste mínimo de 4.5:1 para texto normal e 3:1 para texto grande e controles relevantes.
- Navegação completa por teclado, foco visível e regiões de status anunciadas.
- Labels persistentes; placeholder nunca substitui label.
- Erros em linguagem natural, associados ao campo e sem depender apenas de cor.
- Movimento respeita `prefers-reduced-motion`.
- Interface responsiva para viewport móvel sem perda de função.
- Português do Brasil como idioma inicial, com contratos preparados para idiomas suportados.
