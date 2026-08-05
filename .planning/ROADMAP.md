# Roadmap: Turbo — Canvas de Agentes

## Overview

Turbo é um cockpit visual pessoal: canvas infinito estilo Figma onde cada nó é um terminal ao vivo rodando `claude`, e um Claude pai orquestra filhos via ferramenta MCP `spawn_agent`. A construção vai da fundação Rust/PTY ao spike da costura MCP mais arriscada, depois ao canvas+terminais visíveis, e finaliza integrando o servidor MCP completo no Tauri para fechar o loop de orquestração.

## Phases

- [x] **Phase 1: Foundation — Tauri + PTY** - Janela Wayland funcional e bridge PTY completo (spawn/read/write/resize/kill) (completed 2026-08-05)
- [x] **Phase 2: MCP Spike (binário isolado)** - Provar spawn_agent bloqueante + progress notifications + depth guard fora do Tauri antes de qualquer canvas (completed 2026-08-05)
- [x] **Phase 3: Canvas + Terminal Nodes + Grupos** - ReactFlow canvas com TerminalNodes ao vivo (xterm.js), arraste, zoom e GroupFrames com cwd (completed 2026-08-05)
- [x] **Phase 4: Orquestração MCP Integrada** - Servidor MCP embutido no Tauri completo, spawn_agent criando filhos no canvas com arestas pai→filho e grupos corretos (completed 2026-08-05)

## Phase Details

### Phase 1: Foundation — Tauri + PTY

**Goal**: O app abre em Hyprland/Wayland com janela visível e o backend consegue spawnar, ler, escrever, redimensionar e matar processos PTY de forma não-bloqueante e sem órfãos
**Depends on**: Nothing (first phase)
**Requirements**: FND-01, FND-02, FND-03, FND-04, FND-05, FND-06
**Success Criteria** (what must be TRUE):

  1. `cargo tauri dev` abre janela branca/cinza visível no Hyprland sem exports manuais de env (WEBKIT_DISABLE_DMABUF_RENDERER resolvido em main())
  2. Um processo PTY spawna, sua saída chega ao frontend em streaming via Channel preservando UTF-8 e sequências ANSI em fronteiras de chunk
  3. Digitação de teclado no frontend chega ao processo PTY (round-trip funciona: digitar `echo hello` exibe `hello`)
  4. Redimensionar o terminal envia SIGWINCH ao PTY sem causar loop de resize
  5. Fechar o app encerra todos os PTYs filhos — `ps aux | grep claude | grep -v grep` retorna zero resultados

**Plans**: 1/1 plans complete

- [x] 01-01-PLAN.md — Fechar gaps D-04 (fan-out + backpressure) e FND-05 (debounce) e verificar o round-trip PTY contra os 5 success criteria

### Phase 2: MCP Spike (binário isolado)

**Goal**: Um binário standalone prova que spawn_agent bloqueante funciona com rmcp + portable-pty no mesmo runtime tokio — com progress notifications evitando timeout e depth guard bloqueando recursão — antes de qualquer linha de canvas ou integração Tauri
**Depends on**: Phase 1
**Requirements**: ORCH-01, ORCH-04, ORCH-05, ORCH-06
**Success Criteria** (what must be TRUE):

  1. O binário `turbo-mcp-spike` inicia um servidor Streamable HTTP em 127.0.0.1, recebe a tool call `spawn_agent("say hello", "teste")` e retorna a saída do `claude -p` corretamente
  2. Uma tarefa que demora mais de 60 s completa sem timeout — logs mostram progress notifications emitidas a cada ~10 s durante a execução
  3. Uma chamada de `spawn_agent` originada de um filho (depth 2) é rejeitada com erro de profundidade sem spawnar neto
  4. Duas chamadas `spawn_agent` concorrentes retornam resultados corretos para cada chamador sem misturar outputs

**Plans**: 1/1 plans complete

- [ ] 02-PLAN.md

### Phase 3: Canvas + Terminal Nodes + Grupos

**Goal**: O canvas infinito exibe TerminalNodes ao vivo ligados a PTYs reais, o usuário pode pan/zoom/arrastar nós, e múltiplos GroupFrames com cwds distintos coexistem no mesmo canvas
**Depends on**: Phase 1
**Requirements**: TERM-01, TERM-02, TERM-03, TERM-04, CANV-01, CANV-02, CANV-03, CANV-04, GRP-01, GRP-02, GRP-04
**Success Criteria** (what must be TRUE):

  1. O canvas abre com pan e zoom fluidos; arrastar um nó reposiciona-o sem travar o scroll ou piscar outros nós
  2. Cada TerminalNode exibe saída streaming de um PTY real com renderer canvas (addon-canvas); o nó em foco pode alternar para WebGL sem que outros nós percam contexto
  3. O status do processo (rodando / terminou ok / terminou com erro) aparece visivelmente no cabeçalho do nó
  4. Um botão no nó mata o PTY individual e remove o nó do canvas sem derrubar os demais
  5. Dois GroupFrames com cwds diferentes coexistem no canvas — cada um tem seu Claude pai e seus filhos contidos visualmente no frame
  6. 15 terminais simultâneos rodam sem perda de contexto WebGL e sem jank visível no pan/zoom (ReactProfiler sem re-render cascata)

**Plans**: 1/1 plans complete

- [ ] 03-PLAN.md

**UI hint**: yes

### Phase 4: Orquestração MCP Integrada

**Goal**: O servidor MCP rmcp roda embutido no runtime Tauri, o Claude pai enxerga a tool spawn_agent via `.mcp.json`, chamá-la cria um nó-filho visível no canvas com aresta pai→filho, e o filho pertence ao grupo correto do pai
**Depends on**: Phase 2, Phase 3
**Requirements**: ORCH-02, ORCH-03, ORCH-07, GRP-03
**Success Criteria** (what must be TRUE):

  1. O Claude pai lançado num GroupFrame enxerga a tool `spawn_agent` (`.mcp.json` escrito após health-check do servidor — não antes)
  2. Chamar `spawn_agent(tarefa, label)` via Claude pai cria um novo TerminalNode filho no canvas com o label da tarefa no cabeçalho e uma aresta visual ligando pai→filho
  3. O output final do filho retorna para o Claude pai (call bloqueante completa com resultado correto)
  4. Três chamadas `spawn_agent` concorrentes do mesmo pai criam três nós filhos simultâneos e retornam outputs corretos para cada chamador
  5. O filho spawado aparece dentro do GroupFrame do pai, não solta no canvas raiz

**Plans**: 1/1 plans complete

- [x] 04-PLAN.md — MCP server embedded in Tauri, create_group D-02 ordering, spawn_agent→canvas, radial fan layout, concurrent spawns

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation — Tauri + PTY | 1/1 | Complete   | 2026-08-05 |
| 2. MCP Spike (binário isolado) | 1/1 | Complete   | 2026-08-05 |
| 3. Canvas + Terminal Nodes + Grupos | 1/1 | Complete   | 2026-08-05 |
| 4. Orquestração MCP Integrada | 1/1 | Complete (GUI verify pending) | 2026-08-05 |
