---
phase: 3
title: Canvas + Terminal Nodes + Grupos
wave: 1
depends_on: [1]
autonomous: true
requirements: [TERM-01, TERM-02, TERM-03, TERM-04, CANV-01, CANV-02, CANV-03, CANV-04, GRP-01, GRP-02, GRP-04]
files_modified:
  - app/package.json
  - app/src-tauri/Cargo.toml
  - app/src-tauri/src/lib.rs
  - app/src-tauri/capabilities/default.json
  - app/src/App.tsx
  - app/src/App.css
  - app/src/canvas/Canvas.tsx
  - app/src/canvas/store.ts
  - app/src/canvas/TerminalNode.tsx
  - app/src/canvas/GroupFrame.tsx
  - app/src/canvas/usePty.ts
---

# Phase 3 — PLAN: Canvas + Terminal Nodes + Grupos

## Goal

Transformar o app da Phase 1 (um terminal) num **canvas infinito** (@xyflow/react)
onde cada nó é um TerminalNode ao vivo (xterm), com pan/zoom/arrastar, status por nó,
kill individual, e **múltiplos GroupFrames** com cwds distintos coexistindo. Ao criar
um grupo, o app abre um **file picker nativo** pro cwd e **auto-lança um `claude`** nesse
diretório. Sem MCP/spawn_agent ainda (Phase 4).

## Design decisions (de 03-CONTEXT.md)

- **Visual:** dark + marca vermelha (fundo grafite, cabeçalho do nó no gradiente
  `#9E2A1A→#5C160D` da logo, terminal escuro).
- **Criar grupo:** botão "Novo grupo" + **file picker nativo** (plugin dialog do Tauri).
- **Iniciar pai:** ao criar o grupo, auto-lança `claude` interativo no cwd (na Phase 4
  entra o `.mcp.json`; aqui só sobe o `claude`).
- **Renderer:** `@xterm/addon-canvas` por padrão; WebGL só no nó em foco (limite de contextos).
- **Grupos:** conceito nativo de sub-flow/`parentNode` do @xyflow; filhos contidos no frame.
- **Perf:** `React.memo` + seletor por nó, debounce no FitAddon; alvo 15 terminais sem jank.

## Artifacts this phase produces

- `Canvas`, `TerminalNode`, `GroupFrame`, `usePty` hook, `store` (nós/arestas/grupos/cwd)
- Comando Rust `pick_directory` (ou uso do `@tauri-apps/plugin-dialog`) e `create_group`/auto-launch
- Refactor do `Terminal.tsx` da Phase 1 para `usePty` reutilizável no TerminalNode

## Tasks

<task id="1" wave="1">
<title>Deps + shell do canvas (pan/zoom, tema dark)</title>
<read_first>
- .planning/research/STACK.md (@xyflow/react 12.x, custom nodes)
- app/src/App.tsx, app/src/App.css (shell atual)
</read_first>
<action>
`npm i @xyflow/react @tauri-apps/plugin-dialog` no app; adicionar `tauri-plugin-dialog` no
Cargo.toml e registrá-lo no builder (`lib.rs`), liberar `dialog:default` em
`capabilities/default.json`. Criar `src/canvas/Canvas.tsx` com `<ReactFlow>` (Background,
Controls), pan/zoom/drag habilitados, tema dark (importar `@xyflow/react/dist/style.css` +
overrides no App.css com as vars da marca). Trocar o `<main>` do App.tsx pra renderizar o Canvas.
</action>
<acceptance_criteria>
- Canvas abre com fundo grafite; pan/zoom fluidos; um nó placeholder pode ser arrastado. [CANV-01, CANV-02]
- `npm run build` (tsc+vite) verde; `cargo build` verde.
</acceptance_criteria>
<verify>npm run build; cargo build; abrir e checar pan/zoom/drag no Hyprland.</verify>
</task>

<task id="2" wave="1">
<title>usePty hook + TerminalNode (nó de terminal ao vivo)</title>
<read_first>
- app/src/components/Terminal.tsx (lógica xterm↔pty da Phase 1 — extrair p/ hook)
- .planning/research/PITFALLS.md (WebGL context, FitAddon loop, re-render)
</read_first>
<action>
Extrair a lógica de `Terminal.tsx` para `src/canvas/usePty.ts` (spawn/stream/input/resize/kill,
Channel de bytes, evento `pty_exit`, estado `status: running|exited|error`). Criar
`src/canvas/TerminalNode.tsx` (custom node do react-flow): cabeçalho com **label**, **badge de
status** e **botão kill**; corpo = host do xterm via `usePty`. Renderer `addon-canvas` por padrão;
trocar p/ WebGL só quando o nó ganha foco (e reverter ao perder). `React.memo` no nó, seletor por id.
Registrar `nodeTypes={{ terminal: TerminalNode }}`.
</action>
<acceptance_criteria>
- Um TerminalNode mostra shell ao vivo, aceita digitação, redimensiona com o nó. [TERM-01, TERM-02]
- Status (rodando/ok/erro) aparece no cabeçalho; kill mata o pty e remove o nó sem derrubar os outros. [TERM-03, TERM-04]
- Sem cascata de re-render ao digitar num nó (ReactProfiler). [CANV-04]
</acceptance_criteria>
<verify>Abrir 2+ TerminalNodes, digitar, matar um; medir re-render.</verify>
</task>

<task id="3" wave="1">
<title>Store do canvas + GroupFrame com cwd + auto-launch do claude</title>
<read_first>
- .planning/research/FEATURES.md (sub-flows/parentNode p/ grupos)
- .planning/research/ARCHITECTURE.md (abstração grupo/cwd, node_created via evento)
</read_first>
<action>
Criar `src/canvas/store.ts` (zustand ou estado do react-flow) com nós/arestas/grupos e o cwd
por grupo. `src/canvas/GroupFrame.tsx`: nó-frame (group node do react-flow) que contém seus
terminais (`parentNode`+`extent:'parent'`). Botão "Novo grupo" na toolbar → abre o **file picker
nativo** (`open({ directory:true })` do plugin dialog) → cria um GroupFrame com aquele cwd →
**auto-lança** um TerminalNode "pai" dentro do frame rodando `claude` (via `pty_spawn` com
`command:"claude"`, `cwd`) ou o shell se `claude` faltar. Arestas pai→filho preparadas (a criação
automática de filhos é Phase 4, mas o desenho de aresta já funciona). [CANV-03]
</action>
<acceptance_criteria>
- "Novo grupo" abre o seletor de pasta nativo e cria um frame com o cwd escolhido. [GRP-01, GRP-02]
- O frame sobe um terminal `claude` (ou shell) já no cwd certo.
- Dois GroupFrames com cwds diferentes coexistem, isolados. [GRP-04]
</acceptance_criteria>
<verify>Criar 2 grupos com pastas diferentes; confirmar cwd (ex: `pwd` no terminal) e isolamento.</verify>
</task>

<task id="4" wave="1">
<title>Perf pass + verificação de escala</title>
<read_first>
- .planning/research/PITFALLS.md (WebGL exhaustion, FitAddon debounce)
- .planning/ROADMAP.md (Phase 3 success criteria)
</read_first>
<action>
Debounce no FitAddon; garantir addon-canvas como default e WebGL só-no-foco; memoização dos
nós; evitar recriar objetos inline nos props do react-flow. Testar 15 TerminalNodes simultâneos:
pan/zoom fluido, sem perda de contexto WebGL, sem re-render cascata. Ajustar tamanho default do nó
e cols/rows iniciais (fit-on-mount).
</action>
<acceptance_criteria>
- 15 terminais simultâneos sem perda de contexto WebGL e sem jank visível. [CANV-04]
</acceptance_criteria>
<verify>Abrir 15 nós, medir com ReactProfiler + inspeção visual do pan/zoom.</verify>
</task>

## must_haves

truths:
  - "O canvas abre com pan/zoom/drag fluidos; arrastar um nó reposiciona sem travar o scroll. [CANV-01, CANV-02]"
  - "Cada TerminalNode exibe um PTY real ao vivo com renderer canvas; foco pode alternar p/ WebGL sem derrubar outros nós. [TERM-01, TERM-02]"
  - "Status do processo (rodando/ok/erro) aparece no cabeçalho do nó; botão mata o pty e remove só aquele nó. [TERM-03, TERM-04]"
  - "Dois GroupFrames com cwds diferentes coexistem; cada um sobe um terminal (claude/shell) no seu cwd. [GRP-01, GRP-02, GRP-04]"
  - "15 terminais simultâneos rodam sem perda de contexto WebGL e sem jank (ReactProfiler sem cascata). [CANV-04]"

## Verification

Manual (precisa de display no Hyprland): criar grupos, arrastar/zoom, abrir 15 nós, matar nós.
Automático: `npm run build` + `cargo build` verdes. O file picker usa o plugin dialog do Tauri
(nativo). Arestas pai→filho são desenháveis aqui; a criação automática via spawn_agent é Phase 4.

## Notes / flags para a execução

- Confirmar a API atual do `@xyflow/react` 12.x para group nodes (`parentNode` vs `parentId`,
  `extent:'parent'`) na versão instalada.
- xterm dentro de nó com transform de zoom: garantir que o FitAddon mede a geometria real
  (CSS transform do canvas vs cols/rows) — ver PITFALLS.
- Se `claude` não estiver no PATH do processo, cair pro shell e logar aviso no nó.
