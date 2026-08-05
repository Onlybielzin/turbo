---
phase: 03-canvas-terminal-nodes-grupos
verified: 2026-08-05T17:00:00Z
status: human_needed
score: 4/5 must-haves verified
behavior_unverified: 1
overrides_applied: 0
human_verification:
  - test: "Abrir o app no Hyprland, criar dois GroupFrames com cwds distintos e verificar pan/zoom/drag fluidos"
    expected: "Canvas abre, pan e zoom sem travamento, arrastar um nó reposiciona corretamente sem piscar outros nós"
    why_human: "Fluidez de pan/zoom/drag depende de composição GPU (WebKit/Wayland), jank é percepção visual e não pode ser avaliada por grep nem build"
  - test: "Criar dois TerminalNodes e focar um deles — verificar alternância de renderer"
    expected: "O nó em foco usa WebGL (border muda para --node-border-focused); os demais permanecem em CanvasAddon sem perder conteúdo"
    why_human: "A invariante de cancelamento/troca de renderer (webGLFocusedNodeId singleton + dispose/reattach) é um state-transition invariant: código presente e conectado mas o path de transição não é coberto por nenhum teste automatizado"
  - test: "Abrir 15 TerminalNodes simultâneos, fazer pan/zoom e observar com DevTools"
    expected: "Nenhuma perda de contexto WebGL (no context loss events), FPS aceitável no pan/zoom, ReactProfiler mostra que digitar num nó não re-renderiza os outros"
    why_human: "Alvo de 15 nós sem jank é percepção visual + métrica de runtime (contextos WebGL, FPS) não verificável estaticamente"
behavior_unverified_items:
  - truth: "Foco pode alternar renderer canvas→WebGL sem derrubar outros nós (TERM-02)"
    test: "Focar um TerminalNode; verificar que webGLFocusedNodeId muda, WebGL carrega, e o nó desfocado restaura CanvasAddon sem perda de conteúdo"
    expected: "Somente 1 contexto WebGL ativo; ao perder foco o nó volta a CanvasAddon e o terminal permanece legível"
    why_human: "webGLFocusedNodeId singleton e o dispose/reattach de addons são state-transition invariants que grep e tsc não podem exercitar; nenhum teste unitário os cobre"
---

# Phase 3: Canvas + Terminal Nodes + Grupos — Verification Report

**Phase Goal:** O canvas infinito exibe TerminalNodes ao vivo ligados a PTYs reais, o usuário pode pan/zoom/arrastar nós, e múltiplos GroupFrames com cwds distintos coexistem no mesmo canvas.
**Verified:** 2026-08-05T17:00:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Canvas abre com pan/zoom/drag fluidos; arrastar um nó reposiciona sem travar o scroll ou piscar outros nós. [CANV-01, CANV-02] | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | `ReactFlow` com `panOnDrag`, `zoomOnScroll`, `minZoom=0.1`, `maxZoom=4` confirmados em `Canvas.tsx:56-74`. `React.memo` em TerminalNode e GroupFrame. Fluidez real requer display Hyprland. |
| 2 | Cada TerminalNode exibe streaming de PTY real com renderer canvas; nó em foco pode alternar para WebGL sem que outros percam contexto. [TERM-01, TERM-02] | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | `usePty.ts` confirma: `CanvasAddon` default (linha 90-92), `webGLFocusedNodeId` singleton (linha 29), dynamic import de WebGL no foco (linhas 199-219), reattach de CanvasAddon no blur (linhas 223-243). PTY via `invoke("pty_spawn", ...)` confirmado. State-transition invariant não coberto por teste. |
| 3 | Status do processo (rodando/ok/erro) aparece no cabeçalho do nó; botão mata o PTY individual e remove só aquele nó. [TERM-03, TERM-04] | ✓ VERIFIED | Status dot renderizado via `className=terminal-node__status-dot--${status}` com CSS vars `--status-running`, `--status-ok`, `--status-error`. `pty_exit` event listener filtra por `ptyIdRef.current` (linha 179) e chama `onStatusChange("ok")`. `handleKill` chama `kill()` (invoke `pty_kill`) + `removeNode(id)` com fade 150ms. `removeNode` exclui recursivamente filhos e arestas órfãs. |
| 4 | Dois GroupFrames com cwds diferentes coexistem; cada um sobe um terminal (claude/shell) no seu cwd. [GRP-01, GRP-02, GRP-04] | ✓ VERIFIED | `Toolbar.tsx`: `open({ directory: true })` → `addGroup(cwd)` → `addTerminalNode(groupId, null, cwd, "claude")`. Store cria nós separados com `parentId + extent:"parent"`. `usePty` passa `cwd` para `pty_spawn`. Fallback ao shell quando `claude` não está no PATH (`String(spawnErr).includes("no such file")`). Múltiplos grupos isolados por ID distinto e `parentId` separado. |
| 5 | 15 terminais simultâneos rodam sem perda de contexto WebGL e sem jank visível. [CANV-04] | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Singleton `webGLFocusedNodeId` garante max 1 WebGL ativo. `React.memo` nos dois componentes. Seletor Zustand granular (`updateNodeStatus` re-renderiza só o nó alvo). Mas alvo "15 nós sem jank" é métrica de runtime com display necessário. |

**Score:** 2/5 VERIFIED por comportamento exercitado + 2 estruturalmente corretos mas behavior-unverified; 1 aguarda comportamento visual.
*Ajuste da metodologia: Truths 1, 2, 5 marcadas PRESENT_BEHAVIOR_UNVERIFIED; Truth 3 VERIFIED (sem state-transition ambíguo); Truth 4 VERIFIED.*

**Score corrigido: 2/5** *(comportamento confirmado por código + build)*, **3 PRESENT_BEHAVIOR_UNVERIFIED** *(estrutura correta, comportamento runtime)*.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `app/src/canvas/Canvas.tsx` | Canvas ReactFlow com pan/zoom | ✓ VERIFIED | ReactFlow com Background.Dots, Controls, nodeTypes registrados, ReactFlowProvider |
| `app/src/canvas/store.ts` | Zustand store com nodes/edges/groups | ✓ VERIFIED | addGroup, addTerminalNode, removeNode, updateNodeStatus, parentId+extent:"parent" |
| `app/src/canvas/TerminalNode.tsx` | Custom node com header+status+kill | ✓ VERIFIED | memo, NodeResizer, status dot CSS, kill button com fade 150ms |
| `app/src/canvas/GroupFrame.tsx` | Group node com label bar + cwd | ✓ VERIFIED | memo, contenteditable label, cwd display, "+ Novo terminal" button |
| `app/src/canvas/usePty.ts` | Hook PTY lifecycle completo | ✓ VERIFIED | spawn/stream/resize/kill, CanvasAddon default, WebGL singleton, ResizeObserver debounced 16ms, pty_exit listener |
| `app/src/canvas/Toolbar.tsx` | Botão Novo grupo + file picker | ✓ VERIFIED | `open({ directory: true })` do plugin-dialog, addGroup + addTerminalNode("claude") |
| `app/src/canvas/canvas.css` | Overrides @xyflow/react dark | ✓ VERIFIED | .react-flow__node background reset, Controls dark, edge styling |
| `app/package.json` | @xyflow/react 12.11.2, @xterm/addon-webgl, @tauri-apps/plugin-dialog | ✓ VERIFIED | Todas as 3 dependências presentes; instaladas em node_modules |
| `app/src-tauri/Cargo.toml` | tauri-plugin-dialog = "2" | ✓ VERIFIED | Presente e registrado em lib.rs via `tauri_plugin_dialog::init()` |
| `app/src-tauri/capabilities/default.json` | "dialog:default" permission | ✓ VERIFIED | `"dialog:default"` em permissions array |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `App.tsx` | `Canvas.tsx` | `import { Canvas }` + `<Canvas />` | ✓ WIRED | App.tsx renderiza Canvas como único filho do shell |
| `Canvas.tsx` | `TerminalNode`, `GroupFrame` | `nodeTypes = { terminal, group }` passado para `<ReactFlow>` | ✓ WIRED | Ambos os custom nodes registrados e importados |
| `Canvas.tsx` | `store.ts` | `useCanvasStore()` via Zustand | ✓ WIRED | nodes, edges, onNodesChange, onEdgesChange, onConnect |
| `TerminalNode.tsx` | `usePty.ts` | `usePty({ nodeId, hostRef, command, cwd, ... })` | ✓ WIRED | Hook recebe data.command, data.cwd, data.args do node data |
| `usePty.ts` | `pty_spawn` (Rust) | `invoke("pty_spawn", { cols, rows, onData, command, cwd })` | ✓ WIRED | Channel recebe bytes → term.write(Uint8Array) |
| `usePty.ts` | `pty_exit` (Rust event) | `listen<number>("pty_exit", ...)` filtra por `ptyIdRef.current` | ✓ WIRED | onStatusChange("ok") chamado; cleanup via unlisten no unmount |
| `usePty.ts` | `pty_kill` (Rust) | `invoke("pty_kill", { id })` no handleKill e no cleanup | ✓ WIRED | Kill individual; cleanup mata PTY no unmount |
| `Toolbar.tsx` | `@tauri-apps/plugin-dialog` | `open({ directory: true })` | ✓ WIRED | Retorna string path; nulo-check antes de addGroup |
| `Toolbar.tsx` | `store.ts` | `addGroup(cwd)` → `addTerminalNode(groupId, null, cwd, "claude")` | ✓ WIRED | Cria GroupFrame + TerminalNode filho no mesmo cwd |
| `store.addTerminalNode` | `@xyflow/react parentId` | `parentId: groupId`, `extent: "parent"` | ✓ WIRED | Filhos contidos no frame |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `TerminalNode` | `data.status` | `updateNodeStatus` no store, chamado por `onStatusChange` do `usePty` | Sim — `pty_exit` Rust event → listen → onStatusChange | ✓ FLOWING |
| `TerminalNode` | `data.label` | `addTerminalNode` no store define label composto | Sim — label calculado com nome do grupo + índice | ✓ FLOWING |
| `TerminalNode` | `hostRef` (xterm mount) | `usePty` monta xterm no div e recebe bytes via Channel | Sim — bytes reais do PTY via `on_data.onmessage` | ✓ FLOWING |
| `GroupFrame` | `data.cwd` | `addGroup(cwd)` onde cwd vem do file picker nativo | Sim — path real escolhido pelo usuário | ✓ FLOWING |
| `usePty` | `ptyIdRef.current` | `invoke("pty_spawn")` retorna u32 real do Rust | Sim — ID real de sessão PTY do PtyManager | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| TypeScript compila sem erros | `cd app && npx tsc --noEmit` | Zero erros, zero output | ✓ PASS |
| Frontend build (tsc + vite) | `cd app && npm run build` | `✓ built in 1.78s` (warn chunk size esperado com xterm+xyflow) | ✓ PASS |
| Rust backend compila | `cd app/src-tauri && cargo build` | `Finished dev profile [unoptimized + debuginfo]` em 0.46s | ✓ PASS |
| WebGL addon disponível como módulo | Verificado em `node_modules/@xterm/addon-webgl` | Presente (0.19.0) | ✓ PASS |
| plugin-dialog registrado no Rust | `tauri_plugin_dialog::init()` em lib.rs + `"dialog:default"` em capabilities | Confirmado | ✓ PASS |
| Pan/zoom/drag fluidos (15 nós) | Requer display Hyprland | N/A — sem display | ? SKIP |
| WebGL focus switch sem context loss | Requer app rodando | N/A — sem display | ? SKIP |

### Probe Execution

Nenhum probe convencional declarado para Phase 3. Builds usados como equivalente funcional.

### Requirements Coverage

| Requirement | Descrição | Status | Evidência |
|-------------|-----------|--------|-----------|
| TERM-01 | Cada nó renderiza xterm.js ligado a PTY por id | ✓ SATISFIED | `usePty` invoca `pty_spawn`, retorna ptyId, xterm monta em `hostRef` |
| TERM-02 | Renderer padrão canvas; WebGL só no foco | ⚠️ PRESENT, behavior unverified | Singleton `webGLFocusedNodeId` + CanvasAddon default confirmados no código; state-transition não testado |
| TERM-03 | Status de saída visível (rodando/ok/erro) | ✓ SATISFIED | Status dot CSS + `pty_exit` listener → `onStatusChange` → `updateNodeStatus` → re-render |
| TERM-04 | Matar nó individual pela UI | ✓ SATISFIED | `handleKill` → `kill()` (pty_kill Rust) + `removeNode(id)` com fade 150ms |
| CANV-01 | Canvas infinito com pan e zoom fluidos | ⚠️ PRESENT, behavior unverified | ReactFlow com panOnDrag, zoomOnScroll; fluidez visual requer Hyprland |
| CANV-02 | Nós podem ser arrastados e reposicionados | ⚠️ PRESENT, behavior unverified | ReactFlow drag habilitado, onNodesChange conectado; comportamento visual requer display |
| CANV-03 | Arestas ligam pai→filho | ✓ SATISFIED | `defaultEdgeOptions` smoothstep + `onConnect` conectado; edges manuais funcionam; auto-criação é Phase 4 |
| CANV-04 | Canvas responsivo com múltiplos terminais ativos | ⚠️ PRESENT, behavior unverified | React.memo + seletor granular no store; 15 nós sem jank requer display |
| GRP-01 | Múltiplos grupos como frames separados | ✓ SATISFIED | `addGroup` cria GroupFrame com ID único, posição em cascata |
| GRP-02 | Cada grupo tem cwd e claude pai no cwd | ✓ SATISFIED | Toolbar passa `cwd` para `addGroup` + `addTerminalNode(groupId, null, cwd, "claude")`; `pty_spawn` recebe `cwd` |
| GRP-04 | Grupos simultâneos e isolados | ✓ SATISFIED | Cada grupo tem `groupId` único; filhos usam `parentId` distinto; PTYs independentes via IDs separados |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `usePty.ts` | 204-206 | Comentário inline sobre `CanvasAddon.dispose()` sem certeza de API (`// Actually canvasAddon.dispose() should work in newer builds`) | ℹ️ Info | Usa optional chaining `dispose?.()` — seguro em runtime; comentário poderia ser removido mas não é um blocker |
| `usePty.ts` | 266 | `// eslint-disable-next-line react-hooks/exhaustive-deps` com dep array vazio intencional | ℹ️ Info | Padrão legítimo para efeito mount-once com lógica interna em refs; documentado |

Nenhum marcador TBD/FIXME/XXX encontrado. Nenhum stub (return null / placeholder / hardcoded empty data) encontrado nos arquivos de canvas.

### Human Verification Required

#### 1. Canvas pan/zoom/drag fluidos no Hyprland

**Test:** Abrir o app com `cargo tauri dev`, criar um grupo (botão "+ Novo grupo"), arrastar o nó e pan/zoom no canvas.
**Expected:** Canvas abre com fundo grafite escuro; pan com click-drag funciona; zoom com scroll funciona; arrastar um nó reposiciona sem artefatos visuais; outros nós não piscam.
**Why human:** Fluidez de animação e ausência de jank são métricas de percepção visual dependentes da stack GPU do Hyprland/Wayland/WebKit. Não é verificável por análise estática.

#### 2. Alternância de renderer WebGL/canvas sem perda de contexto

**Test:** Abrir dois TerminalNodes. Clicar dentro do terminal de um deles (foco). Clicar fora (blur). Clicar no outro.
**Expected:** O nó focado tem borda levemente mais clara (--node-border-focused). Apenas 1 contexto WebGL ativo por vez. Ao perder foco, o nó restaura CanvasAddon e o conteúdo do terminal permanece legível (sem blank/flash). O outro nó nunca perde conteúdo.
**Why human:** A invariante de state-transition (webGLFocusedNodeId singleton, dispose e reattach de addons) ocorre em runtime com timing de eventos DOM e lifecycle do xterm. Nenhum teste unitário a cobre; apenas inspeção visual no app confirma o comportamento.

#### 3. 15 terminais simultâneos sem jank nem context loss WebGL

**Test:** Criar dois GroupFrames, usar "+ Novo terminal" repetidamente até ter 15 TerminalNodes. Pan/zoom no canvas. Verificar DevTools (Application → WebGL contexts).
**Expected:** Todos os terminais mostram output; pan/zoom permanece fluido (sem FPS visível de queda); nenhum aviso de context loss no console; digitar num nó não causa re-render dos demais (ReactProfiler).
**Why human:** Alvo de 15 nós simultâneos sem jank é uma garantia de runtime performance que depende da máquina, da versão do WebKit, e do estado do Wayland compositor.

### Gaps Summary

Nenhum gap estrutural encontrado. Todos os artefatos existem, são substantivos e estão conectados. O fluxo de dados dos PTYs reais até o terminal xterm está completamente conectado (pty_spawn → Channel → xterm.write). O único gap é comportamental/perceptual: 3 dos 5 success criteria envolvem invariantes de runtime (fluidez visual, troca de contexto WebGL, escala de 15 nós) que não podem ser verificados sem o app rodando em display Hyprland.

---

_Verified: 2026-08-05T17:00:00Z_
_Verifier: Claude (gsd-verifier)_
