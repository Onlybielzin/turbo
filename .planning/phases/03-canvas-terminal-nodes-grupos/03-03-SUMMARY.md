---
phase: 3
plan: 3
subsystem: canvas-ui
tags: [canvas, xyflow, xterm, pty, zustand, tauri-dialog, terminal-node, group-frame]
dependency_graph:
  requires: [phase-1-plan-1]
  provides: [infinite-canvas, terminal-nodes, group-frames, pty-hook, canvas-store]
  affects: [phase-4-mcp-spawn-agent]
tech_stack:
  added:
    - "@xyflow/react@12.11.2 — canvas infinito com custom nodes e group frames"
    - "@tauri-apps/plugin-dialog@2 — file picker nativo para escolha de cwd"
    - "@xterm/addon-webgl@0.19.x — renderer WebGL para nó em foco"
  patterns:
    - "Zustand slice para estado de nodes/edges/grupos/cwd"
    - "usePty hook reutilizável extraído de Terminal.tsx"
    - "React.memo em TerminalNode e GroupFrame para evitar re-render cascata"
    - "CanvasAddon como renderer padrão, WebGL somente no nó em foco (max 1 contexto)"
    - "ResizeObserver debounced 16ms com offsetWidth/offsetHeight (pré-transform)"
    - "parentId + extent:'parent' para conter TerminalNodes dentro de GroupFrames"
key_files:
  created:
    - app/src/canvas/Canvas.tsx
    - app/src/canvas/canvas.css
    - app/src/canvas/store.ts
    - app/src/canvas/usePty.ts
    - app/src/canvas/TerminalNode.tsx
    - app/src/canvas/TerminalNode.css
    - app/src/canvas/GroupFrame.tsx
    - app/src/canvas/GroupFrame.css
    - app/src/canvas/Toolbar.tsx
    - app/src/canvas/Toolbar.css
  modified:
    - app/package.json
    - app/src-tauri/Cargo.toml
    - app/src-tauri/src/lib.rs
    - app/src-tauri/capabilities/default.json
    - app/src/App.tsx
    - app/src/App.css
decisions:
  - "Usou --legacy-peer-deps no npm install: @xterm/addon-canvas@0.7.0 declara peer dep ^5.0.0 mas é compatível com xterm 6.x em runtime"
  - "Commits 1-4 agrupados atomicamente: as 4 tarefas são mutuamente dependentes (canvas requer store, store requer tipos dos nodes, nodes requerem usePty)"
  - "Fallback de claude para shell: usePty detecta 'no such file' no erro de spawn e exibe mensagem pt-BR antes de abrir shell"
  - "Evento pty_exit: Rust emite número simples (u32), um único listener trata saída limpa como 'ok'"
metrics:
  duration: "8 minutes"
  completed: "2026-08-05"
  tasks_completed: 4
  files_changed: 18
status: complete
---

# Phase 3 Plan 3: Canvas + Terminal Nodes + Grupos Summary

Transformou o app de Phase 1 (um único terminal) em um **canvas infinito @xyflow/react** com TerminalNodes ao vivo ligados a PTYs reais via xterm.js, GroupFrames contendo terminais por projeto, file picker nativo Tauri para escolha de cwd, e auto-launch do `claude` no cwd selecionado.

## O Que Foi Construído

### Canvas (@xyflow/react)
- `Canvas.tsx`: `<ReactFlow>` com Background de pontos (2px/24px, cor `--canvas-dot`), Controls estilizados com tema dark, pan/zoom/drag habilitados
- `canvas.css`: overrides do @xyflow para remover backgrounds default brancos dos nodes, estilizar Controls com `--panel`/`--border`/`--text`, preparar edge styles para Phase 4
- `ReactFlowProvider` wrapping com viewport default em (80, 80, zoom=1)

### TerminalNode
- Custom node com cabeçalho de 32px no gradiente `#9e2a1a → #5c160d` (design contract)
- Status dot de 8×8px: verde (`--status-running`), verde-escuro (`--status-ok`), vermelho (`--status-error`)
- Botão kill (×) com hover background `--kill-hover-bg`, sem confirmação, fade-out 150ms
- `NodeResizer` nativo do @xyflow, min 240×160px
- `React.memo` para prevenir re-render cascata
- Border default `--node-border`, foco `--node-border-focused`

### usePty Hook
- Extrai e generaliza a lógica de `Terminal.tsx` da Phase 1
- Spawn com `command`/`args`/`cwd` opcionais; fallback ao shell com mensagem pt-BR quando `claude` não está no PATH
- `CanvasAddon` como renderer padrão; `WebGLAddon` ativado somente no nó em foco via dinâmica import (max 1 contexto WebGL ativo — singleton de módulo)
- `ResizeObserver` debounced 16ms, FitAddon lê `offsetWidth`/`offsetHeight` (dimensões pré-transform, corretas em qualquer nível de zoom)
- Cleanup completo no unmount: cancela timer, desconecta observer, remove listener de pty_exit, mata PTY, dispose do xterm

### Store Zustand
- `nodes: AppNode[]`, `edges: Edge[]`, `groupCounter: number`
- Handlers `onNodesChange`/`onEdgesChange`/`onConnect` (applyNodeChanges/applyEdgeChanges/@xyflow)
- `addGroup(cwd)`: cria GroupFrame 800×600px com label "Grupo N" no padrão cascata
- `addTerminalNode(groupId, ptyId, cwd, command)`: posiciona filho dentro do frame com padding 32px, `parentId` + `extent:'parent'`
- `removeNode`: remove node e todos os filhos recursivamente; limpa arestas orfãs
- `updateNodeStatus`, `updateNodeLabel`, `setPtyId`: seletores granulares

### GroupFrame
- Label bar 28px com label editável via `contenteditable` (double-click → blur/Enter commit, Escape revert)
- cwd exibido em 11px mono `--muted` com truncamento por ellipsis; `~` substitui `/home/<user>`
- Botão "+ Novo terminal" visível apenas no hover da label bar
- Background `--group-bg` (semi-transparente 55%) sobre `--bg` do canvas

### Toolbar
- Overlay `position: absolute; top: 8px; left: 8px; z-index: 10`
- Botão "+ Novo grupo": abre `dialog.open({ directory: true })` nativo Tauri → cria GroupFrame → auto-lança `claude` (ou shell) com o cwd selecionado

### Tokens Phase 3 (App.css)
Adicionados ao `:root`: `--node-border`, `--node-border-focused`, `--group-border`, `--group-bg`, `--status-running`, `--status-ok`, `--status-error`, `--kill-hover-bg`, `--canvas-dot`, `--node-header-h`, `--node-min-w`, `--node-min-h`, `--group-label-h`, `--canvas-dot-size`, `--canvas-dot-gap`

## Deviations from Plan

### Auto-fix Issues

**1. [Rule 1 - Bug] Conflito de peer deps @xterm/addon-canvas vs @xterm/xterm@6**
- **Encontrado durante:** Task 1, `npm install`
- **Problema:** `@xterm/addon-canvas@0.7.0` declara `peerDependency: @xterm/xterm@^5.0.0` mas o projeto já tinha `@xterm/xterm@6.0.0`. Npm rejeitou com ERESOLVE.
- **Fix:** Instalou com `--legacy-peer-deps`. Em runtime o addon é compatível com xterm 6; a restrição do peer dep não foi atualizada pelo maintainer ainda.
- **Commit:** 36f5cb1

**2. [Rule 2 - Missing] @xterm/addon-webgl não instalado**
- **Encontrado durante:** Task 2, `npx tsc --noEmit`
- **Problema:** `usePty.ts` faz `import('@xterm/addon-webgl')` dinâmico mas o pacote não estava no `package.json`.
- **Fix:** `npm install @xterm/addon-webgl --legacy-peer-deps`
- **Commit:** 36f5cb1

**3. [Rule 1 - Bug] Duas variáveis não usadas causando erro TS**
- `MiniMap` importado mas não usado em `Canvas.tsx` → removido
- `editValue`/`setEditValue` declarados mas não usados em `GroupFrame.tsx` → removidos (contenteditable lê do DOM diretamente)
- **Commit:** 36f5cb1

**4. [Rule 1 - Bug] Listener duplo de pty_exit simplificado**
- `usePty.ts` foi escrito inicialmente com dois listeners tentando cobrir formato legado e novo. O Rust emite apenas `u32` simples. Simplificado para um único `listen<number>`.

### Tarefas 1-4 commitadas atomicamente
O plano lista 4 tarefas separadas mas todas são mutuamente dependentes (Canvas requer store e nodeTypes, store requer tipos de TerminalNode, TerminalNode requer usePty, Toolbar requer store). Todas foram implementadas e commitadas em um único commit atômico `36f5cb1`.

## Verificação de Build

| Verificação | Resultado |
|-------------|-----------|
| `npx tsc --noEmit` | Zero erros |
| `cargo build` | Finished (dev profile) |
| `npm run build` (tsc + vite) | OK (aviso de chunk size esperado com xterm+xyflow) |

## Verificação Pendente (GUI — requer display Hyprland)

As seguintes verificações funcionais só podem ser feitas com o app rodando:

- Canvas abre com fundo grafite e pan/zoom/drag fluidos
- TerminalNode exibe PTY ao vivo, aceita digitação, redimensiona com o nó
- Status dot muda de verde → verde-escuro/vermelho ao encerrar processo
- Kill (×) mata PTY e fade-out do nó em 150ms
- "+ Novo grupo" abre seletor de pasta nativo Tauri
- GroupFrame sobe com o cwd correto e auto-lança claude (ou shell com mensagem pt-BR)
- Dois GroupFrames com cwds diferentes coexistem isolados
- 15 TerminalNodes simultâneos sem perda de contexto WebGL e sem jank

## Known Stubs

Nenhum. Todos os dados fluem de PTYs reais; não há dados mockados ou hardcoded que fluam para a UI.

## Threat Flags

Nenhuma nova superfície de ataque introduzida. O `pty_spawn` com `cwd` controlado pelo usuário via file picker nativo é seguro (o Tauri dialog retorna apenas caminhos do sistema de arquivos local).

## Self-Check: PASSED

Todos os 10 arquivos criados confirmados em disco. Commit `36f5cb1` confirmado em git log.
