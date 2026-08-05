# Phase 3: Canvas + Terminal Nodes + Grupos - Context

**Gathered:** 2026-08-04
**Status:** Ready for planning

<domain>
## Phase Boundary

O canvas infinito (ReactFlow/@xyflow) exibindo TerminalNodes ao vivo ligados a PTYs reais (xterm.js), com pan/zoom/arrastar, status por nó, kill individual, e múltiplos GroupFrames com cwds distintos coexistindo. Esta é a fase com identidade visual (UI hint: yes). Sem MCP/spawn_agent ainda (isso é Phase 4) — mas o usuário já cria grupos e o Claude pai já sobe automaticamente em cada grupo.
</domain>

<decisions>
## Implementation Decisions

### Estética / Visual (DECIDIDO pelo usuário)
- **D-01:** Tema **dark + marca vermelha**. Canvas de fundo escuro (grafite). Cabeçalho dos nós na cor da logo (gradiente vermelho `#9E2A1A → #5C160D`, ver `assets/logo.svg`). Terminal com tema escuro. Cockpit sóbrio e coeso com a identidade do Turbo.

### Criação de grupo (DECIDIDO pelo usuário)
- **D-02:** Grupo criado via **botão "Novo grupo" + file picker nativo** (dialog de pasta do Tauri) para escolher o cwd. Nada de digitar caminho no v1.

### Inicialização do Claude pai (DECIDIDO pelo usuário)
- **D-03:** Ao criar o grupo, o app **auto-lança um `claude` interativo** naquele cwd, já com o MCP configurado (na Phase 4 o `.mcp.json` entra; nesta fase o pai sobe como terminal claude no cwd). Experiência "mágica": criar grupo → já está conversando com o pai.

### Renderer / Perf (travado por pesquisa)
- **D-04:** Renderer padrão dos terminais = **@xterm/addon-canvas**. WebGL reservado SÓ ao terminal em foco (limite de ~8–16 contextos WebGL; senão terminais ficam pretos). Alternar renderer no foco sem derrubar os outros.
- **D-05:** Debounce no FitAddon (evitar loop de resize). React.memo + seletor por nó para evitar re-render cascata com muitos terminais (alvo: 15 simultâneos sem jank).
- **D-06:** GroupFrame = usar o conceito nativo de sub-flow/`parentNode` do @xyflow (frame por projeto); filhos ficam contidos visualmente no frame.

### Claude's Discretion
- Layout exato do cabeçalho do nó (posição do label, botão kill, indicador de status).
- Paleta precisa dos cinzas do fundo/nós (desde que dark + acento vermelho da marca).
- Tamanho default do TerminalNode e cols/rows iniciais (ex: 80x24 com fit-on-mount).
- Iconografia do status (cor/badge para rodando / ok / erro).
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requisitos e roadmap
- `.planning/REQUIREMENTS.md` — TERM-01..04, CANV-01..04, GRP-01, GRP-02, GRP-04 (escopo desta fase)
- `.planning/ROADMAP.md` §"Phase 3" — success criteria (incl. 15 terminais sem perda de contexto WebGL, 2 GroupFrames com cwds distintos)

### Marca
- `assets/logo.svg` — cores da identidade (vermelho `#9E2A1A→#5C160D`) usadas no tema dos nós

### Pesquisa (crítico)
- `.planning/research/STACK.md` — @xyflow/react 12.x, @xterm/xterm 6.x + addon-canvas/addon-fit, custom nodes
- `.planning/research/FEATURES.md` — sub-flows para grupos, referência OpenCove, persistência é P2
- `.planning/research/PITFALLS.md` — WebGL context exhaustion, FitAddon loop, ReactFlow re-render, xterm dentro de nó transformado (CSS transform vs geometria)
- `.planning/research/ARCHITECTURE.md` — TerminalNode ligado a pty id, wiring de eventos, abstração de grupo/cwd
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Phase 1: PtyManager + Channel bridge — o TerminalNode assina o Channel de um pty id no mount.
- `assets/logo.svg` — fonte de cor da marca para o tema.

### Established Patterns
- Channel-per-pty (Phase 1 D-03) para streaming; eventos Tauri para topologia (node_created/exited).

### Integration Points
- GroupFrame + cwd desta fase são o alvo onde a Phase 4 anexa filhos criados via spawn_agent.
- O auto-launch do Claude pai (D-03) é o mesmo pai que na Phase 4 recebe o `.mcp.json` e chama spawn_agent.
</code_context>

<specifics>
## Specific Ideas

- "Cockpit" é a metáfora: sóbrio, escuro, com o vermelho do Turbo como acento — não um terminal hacker verde, não neutro sem identidade.
- Perf é critério de aceite real: 15 terminais + pan/zoom fluido, sem re-render cascata (ReactProfiler limpo).
</specifics>

<deferred>
## Deferred Ideas

- Persistência do layout do canvas (salvar/restaurar nós, arestas, grupos, cwd) — é v2 (PERS-01/02), não v1. Ver REQUIREMENTS.md.
- Minimapa e restart de nó reusando posição — v2 (INT-01/02).
- Arestas pai→filho (CANV-03) aparecem visualmente aqui, mas a criação automática de filhos que gera essas arestas é Phase 4.
</deferred>

---

*Phase: 3-Canvas + Terminal Nodes + Grupos*
*Context gathered: 2026-08-04*
