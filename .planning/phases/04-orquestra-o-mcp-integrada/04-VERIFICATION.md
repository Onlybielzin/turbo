---
phase: 04-orquestra-o-mcp-integrada
verified: 2026-08-05T14:45:00Z
status: human_needed
score: 5/5
behavior_unverified: 5
overrides_applied: 0
behavior_unverified_items:
  - truth: "Claude pai num GroupFrame enxerga a tool spawn_agent (.mcp.json escrito APÓS health-check)"
    test: "Criar um grupo no app; no terminal do Claude pai, executar '/tools' ou verificar o context; confirmar que spawn_agent aparece na lista de ferramentas disponíveis"
    expected: "Claude pai lista spawn_agent como ferramenta MCP disponível"
    why_human: "Requer app em execução com display Wayland (Hyprland) e o binário 'claude' no PATH — verificação estrutural do código passou mas o live round-trip não é executável sem GUI"
  - truth: "spawn_agent(tarefa, label) cria novo TerminalNode filho com label no cabeçalho + aresta pai→filho"
    test: "Com o app rodando, fazer o Claude pai chamar spawn_agent com uma tarefa curta; observar o canvas"
    expected: "Um novo TerminalNode aparece no canvas em posição radial ao redor do pai, com o label no cabeçalho e uma aresta animada ligando pai→filho"
    why_human: "Estado visual do canvas requer inspeção humana; o código estrutural está correto e wired mas a transição só pode ser verificada ao vivo"
  - truth: "Output final do filho retorna ao Claude pai (call bloqueante completa com resultado correto)"
    test: "Claude pai chama spawn_agent('echo hello world', 'teste'); aguardar o retorno da tool"
    expected: "Claude pai recebe 'hello world' como resultado da chamada spawn_agent; a chamada completa (não fica pendente)"
    why_human: "Round-trip MCP end-to-end requer claude CLI + servidor MCP em execução + display"
  - truth: "Três spawn_agent concorrentes criam três filhos e retornam outputs corretos a cada chamador"
    test: "Claude pai dispara 3 chamadas spawn_agent concorrentes (ex: via três tool_use paralelos); aguardar os três retornos"
    expected: "Três TerminalNodes filho aparecem no canvas simultâneamente; cada chamador recebe o output correto sem mistura de resultados"
    why_human: "Teste de concorrência requer execução real — verificação estrutural confirma que cada call usa spawn_blocking independente mas o isolamento de outputs só pode ser provado ao vivo"
  - truth: "Filho spawnado aparece dentro do GroupFrame do pai, não solto no canvas raiz"
    test: "Após spawn_agent criar um filho, verificar no canvas que o nó filho está visualmente contido dentro do GroupFrame do pai"
    expected: "Filho contido no GroupFrame (parentId=groupId, extent='parent' no ReactFlow); não aparece no canvas raiz"
    why_human: "Verificação visual do canvas requer GUI; a propriedade parentId/extent está correta no código mas o comportamento de containment do ReactFlow requer inspeção ao vivo"
human_verification:
  - test: "Live MCP handshake: iniciar o app e verificar log 'MCP Streamable HTTP server listening on http://127.0.0.1:PORT/mcp'"
    expected: "Log de startup confirma servidor MCP ouvindo na porta efêmera"
    why_human: "Requer app rodando com Hyprland/Wayland display"
  - test: "spawn_agent visível: criar grupo → no terminal do Claude pai confirmar que '/tools' lista spawn_agent"
    expected: "Claude pai lista spawn_agent como ferramenta MCP disponível (confirma D-02: .mcp.json escrito APÓS health-check)"
    why_human: "Requer display + CLI claude no PATH"
  - test: "Filho aparece no canvas: Claude pai chama spawn_agent(tarefa, label) → verificar TerminalNode filho com label e aresta"
    expected: "Nó filho aparece em posição radial com label correto e aresta animada pai→filho dentro do GroupFrame"
    why_human: "Verificação visual do canvas — parentId/extent estão corretos no código mas o rendering requer GUI"
  - test: "Call bloqueante completa: spawn_agent retorna o stdout do filho para o Claude pai"
    expected: "Claude pai recebe o output completo do filho na resposta da tool call"
    why_human: "Live round-trip MCP: requer claude CLI + servidor em execução"
  - test: "Concorrência: 3 spawn_agent simultâneos → 3 filhos com outputs isolados"
    expected: "3 TerminalNodes aparecem concorrentemente; cada chamador recebe seu output sem mistura"
    why_human: "Teste de concorrência requer execução real do app com múltiplos spawns paralelos"
---

# Phase 4: Orquestração MCP Integrada — Verification Report

**Phase Goal:** O servidor MCP rmcp roda embutido no runtime Tauri, o Claude pai enxerga a tool spawn_agent via `.mcp.json`, chamá-la cria um nó-filho visível no canvas com aresta pai→filho, e o filho pertence ao grupo correto do pai.
**Verified:** 2026-08-05T14:45:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Summary

Verificação estrutural completa: todos os 5 critérios de sucesso têm implementação presente, substantiva e wired no código. Builds verdes: `cargo build` (0.21s, nenhum erro), `tsc --noEmit` (EXIT: 0), `npm run build` (EXIT: 0). As 5 verdades observáveis são `PRESENT_BEHAVIOR_UNVERIFIED` — o código está correto e wired mas o round-trip vivo (claude CLI + servidor MCP em execução + display Hyprland/Wayland) é necessário para verificação comportamental completa.

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Claude pai num GroupFrame enxerga spawn_agent (.mcp.json escrito APÓS health-check) | PRESENT_BEHAVIOR_UNVERIFIED | `mcp::start()` via `block_on` no `setup()` → `McpState{port}` gerenciado → `create_group` só executável após isso → `GroupRegistry::register()` escreve `.mcp.json` com a porta real. Ordenação D-02 garantida por código. |
| 2 | spawn_agent(tarefa, label) cria TerminalNode filho com label + aresta pai→filho | PRESENT_BEHAVIOR_UNVERIFIED | `app.emit("node_created", payload)` em `server.rs:148` ANTES do `spawn_blocking`; `Canvas.tsx:68` ouve e chama `addChildNode`; `store.ts:167` cria nó com `parentId=groupId, extent="parent"` e edge `source=parentNodeId, target=nodeId`. |
| 3 | Output final do filho retorna ao Claude pai (call bloqueante completa) | PRESENT_BEHAVIOR_UNVERIFIED | `run_in_pty_blocking` em `spawn_agent.rs` coleta todo stdout via loop de leitura; `tokio::task::spawn_blocking` wrapping em `server.rs:173`; `Ok(Ok(out))` retorna `CallToolResult::success` com o conteúdo completo. |
| 4 | Três spawn_agent concorrentes criam três filhos com outputs corretos | PRESENT_BEHAVIOR_UNVERIFIED | `StreamableHttpService` do rmcp trata cada conexão num tokio task independente; cada chamada cria seu próprio `spawn_blocking` thread sem mutex compartilhado. Sem serialização — verificado por ausência de lock em `server.rs`. |
| 5 | Filho spawnado aparece dentro do GroupFrame do pai, não solto no canvas raiz | PRESENT_BEHAVIOR_UNVERIFIED | `addChildNode` em `store.ts:189-190` seta `parentId: groupId, extent: "parent"` — esses dois campos são a API do ReactFlow para containment dentro do nó pai. `group_id` vem do payload `node_created` emitido pelo MCP handler com o `group_id` do `SpawnParams`. |

**Score:** 5/5 truths estruturalmente verificadas (0 comportamentalmente exercitadas por testes)

---

## Structural Verification by Requirement

### ORCH-02: Servidor MCP embutido no Tauri; .mcp.json escrito APÓS health-check

**Evidence:**

**Artifact: `app/src-tauri/src/mcp/server.rs`** — VERIFIED (substantivo, wired)
- `rmcp::transport::streamable_http_server::StreamableHttpService` instanciado com `LocalSessionManager` e axum router em `/mcp`
- `tokio::net::TcpListener::bind("127.0.0.1:0")` — porta efêmera; `listener.local_addr()?.port()` retorna a porta real
- `tokio::spawn(async move { axum::serve(listener, router).await })` — server como background task no runtime Tauri
- Compartilha `Arc<PtyManager>` via `SpawnServer::new(depth_limit, Arc::clone(&pm), app_clone)`

**Artifact: `app/src-tauri/src/lib.rs`** (ordering D-02) — VERIFIED
- `run()` chama `tauri::async_runtime::block_on(async move { mcp::start(...).await })` no `.setup()` hook — bloqueia a inicialização do app até o servidor estar ouvindo
- Somente após `mcp::start()` retornar `Ok(port)` é que `app_handle.manage(McpState { port })` é executado
- `create_group` command usa `State<'_, McpState>` — o Tauri só permite invocar o comando após `McpState` estar no state, o que só acontece após o servidor estar ouvindo
- Portanto `.mcp.json` nunca pode ser escrito antes do servidor estar pronto: a cadeia `block_on → McpState::manage → create_group invocável → groups.rs::register → fs::write .mcp.json` é determinística

**Artifact: `app/src-tauri/src/groups.rs`** — VERIFIED
- `GroupRegistry::register()` escreve `.mcp.json` com `"type": "http"` e URL `http://127.0.0.1:{port}/mcp?group_id={group_id}`
- `group_id` é embedado na URL como query param — o handler MCP pode ler o grupo de cada conexão

**Artifact: `app/src/canvas/Toolbar.tsx`** (D-02 front-end enforcement) — VERIFIED
- `await invoke("create_group", { groupId, cwd })` — await garante que `.mcp.json` existe antes de prosseguir
- `addTerminalNode(...)` só é chamado DEPOIS do `await` — `usePty` monta e spawna claude somente após `.mcp.json` estar no disco

### ORCH-03: spawn_agent bloqueia e retorna output; node_created event wired

**Evidence:**

**Artifact: `app/src-tauri/src/mcp/spawn_agent.rs`** — VERIFIED
- `run_in_pty_blocking()`: abre PTY via `portable-pty`, itera com `reader.read()` coletando todos os bytes em `Vec<u8>`, aguarda `child.wait()`, retorna `String::from_utf8_lossy(&buf).into_owned()`
- Não usa `std::thread::spawn` raw — chamado via `tokio::task::spawn_blocking` em `server.rs:173` (Phase 2 review fix confirmado)

**Key link: MCP handler → Tauri event → Canvas** — VERIFIED
- `server.rs:142-148`: `NodeCreatedPayload{group_id, parent_pty_id, child_pty_id, label}` emitido via `self.app.emit("node_created", payload)` ANTES do `spawn_blocking`
- `Canvas.tsx:68`: `listen<NodeCreatedPayload>("node_created", ...)` com handler que chama `addChildNode`
- `store.ts:167-228`: `addChildNode` cria nó com `parentId=groupId, extent="parent"`, posição radial via `childPosition()`, e edge `source=parentNodeId → target=nodeId` animado com `MarkerType.ArrowClosed`

**Artifact: `app/src/canvas/layout.ts`** — VERIFIED
- `childPosition(parentPos, index, totalChildren)` implementa fan radial: `FAN_RADIUS=380px`, `FAN_SPREAD=144°`
- Angle interpolado entre `FAN_START` e `FAN_START + FAN_SPREAD` — distribui filhos em arco ao redor do pai

### ORCH-07: Concorrência — 3 chamadas simultâneas, filhos isolados

**Evidence:**

**Artifact: `app/src-tauri/src/mcp/server.rs`** — VERIFIED (estruturalmente)
- `async fn spawn_agent(...)` — não há mutex, RwLock ou qualquer serialização entre chamadas
- Cada invocação MCP cria seu próprio `tokio::task::spawn_blocking` thread independente
- `StreamableHttpService` do rmcp processa cada request em seu próprio tokio task (by design do transporte Streamable HTTP)
- Portanto 3 chamadas concorrentes → 3 tokio tasks → 3 `spawn_blocking` OS threads → 3 PTYs independentes

### GRP-03: Filho aparece dentro do GroupFrame correto

**Evidence:**

**Key link: MCP SpawnParams.group_id → addChildNode.groupId → parentId** — VERIFIED
- `SpawnParams.group_id` (enviado pelo Claude pai na tool call) → `NodeCreatedPayload.group_id` (emitido no evento)
- `Canvas.tsx:69`: `const { group_id, ... } = event.payload`
- `addChildNode({ groupId: group_id, ... })` em `store.ts:189`: `parentId: groupId, extent: "parent"`
- ReactFlow honra `parentId + extent: "parent"` para containment — filho não pode sair do frame pai

**Group routing via URL query param:** — VERIFIED
- `.mcp.json` escrito com URL `?group_id={group_id}` — grupos diferentes têm configs diferentes
- O `SpawnParams.group_id` que o Claude pai passa na tool call identifica qual GroupFrame usar para o filho

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `app/src-tauri/src/mcp/mod.rs` | Módulo MCP, re-exports | VERIFIED | Existe, substantivo, importado em `lib.rs` |
| `app/src-tauri/src/mcp/server.rs` | rmcp StreamableHttpService + spawn_agent handler | VERIFIED | 265 linhas, completamente implementado |
| `app/src-tauri/src/mcp/spawn_agent.rs` | run_in_pty_blocking via spawn_blocking | VERIFIED | 61 linhas, PTY blocking loop completo |
| `app/src-tauri/src/groups.rs` | GroupRegistry: register() + .mcp.json write | VERIFIED | 85 linhas, escreve config com group_id na URL |
| `app/src/canvas/layout.ts` | childPosition() radial fan | VERIFIED | 52 linhas, FAN_RADIUS=380px, 144° arc |
| `app/src/canvas/store.ts` (addChildNode) | Cria filho com parentId + edge | VERIFIED | addChildNode implementado com parentId=groupId, extent=parent, edge animado |
| `app/src/canvas/Canvas.tsx` (node_created listener) | Ouve evento, chama addChildNode | VERIFIED | useEffect com listen("node_created",...) wired a addChildNode |
| `app/src/canvas/Toolbar.tsx` (D-02 ordering) | await create_group antes de addTerminalNode | VERIFIED | Sequência await + addTerminalNode com env vars confirmada |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `mcp::start()` em `lib.rs:setup` | `McpState{port}` em app state | `block_on` + `.manage()` | VERIFIED | Servidor inicia antes de qualquer janela; porta guardada no state |
| `create_group` command | `.mcp.json` escrito | `GroupRegistry::register()` via `State<McpState>` | VERIFIED | `mcp_state.port` passado ao register(); apenas se McpState disponível |
| `Toolbar.tsx:await invoke("create_group")` | `addTerminalNode` com command="claude" | await sequência | VERIFIED | D-02: `.mcp.json` no disco antes de usePty spawnar claude |
| `spawn_agent` handler | `node_created` Tauri event | `self.app.emit("node_created", payload)` | VERIFIED | Emitido em `server.rs:148`, antes do `spawn_blocking` |
| `Canvas.tsx listen("node_created")` | `addChildNode()` no store | event handler em `useEffect` | VERIFIED | `group_id, parent_pty_id, label` extraídos e passados ao addChildNode |
| `addChildNode` | child node com `parentId=groupId` | `store.ts:189-190` | VERIFIED | `parentId: groupId, extent: "parent"` garante containment ReactFlow |
| `addChildNode` | edge pai→filho | `store.ts:207-221` | VERIFIED | `edge.source=parentNodeId, target=nodeId, animated=true, ArrowClosed` |
| `run_in_pty_blocking` | stdout acumulado retornado | loop `reader.read()` + `child.wait()` | VERIFIED | Coleta todos os bytes; retorna `CallToolResult::success(stdout)` |

---

## Build Verification

| Check | Command | Result | Status |
|-------|---------|--------|--------|
| Rust compilation | `cargo build` (manifest: app/src-tauri) | `Finished dev profile in 0.21s` | PASS |
| TypeScript typecheck | `tsc --noEmit` (app/) | EXIT: 0, sem erros | PASS |
| Frontend build | `npm run build` (app/) | EXIT: 0, 214 modules, dist gerado | PASS |

---

## Data-Flow Trace (Level 4)

### spawn_agent → canvas child node

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `Canvas.tsx` | `event.payload` (NodeCreatedPayload) | Tauri event emitido por `server.rs:emit("node_created")` | Sim — grupo real, label real da tool call | FLOWING |
| `store.ts addChildNode` | `groupId, parentNodeId, label` | Payload do evento, nodes existentes do store | Sim — posição calculada por `childPosition()`, edge real criado | FLOWING |
| `server.rs spawn_agent` | `out: String` | `run_in_pty_blocking` — stdout real do PTY | Sim — captura todo output do processo filho | FLOWING |

---

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `usePty.ts` | 140 | "not yet implemented" em bloco catch de `pty_attach_channel` | INFO | Caminho alternativo (`existingPtyId`) não é usado pela phase 4 — `create_group` não mais spawna PTY; o bloco catch é dead code no fluxo atual. Não afeta a goal da phase 4. |
| `Toolbar.tsx` | 53 | `console.error(...)` | INFO | Error handler legítimo — não é debug logging, é tratamento de falha de `create_group`. Aceitável. |

Nenhum marcador `TBD`, `FIXME`, `XXX` encontrado em arquivos modificados pela phase 4.

---

## Phase 2 Review Fixes Verification

Conforme solicitado nas instruções de verificação:

| Fix | Evidence | Status |
|-----|----------|--------|
| PTY via spawn_blocking (no thread leak on cancel) | `spawn_agent.rs` usa `run_in_pty_blocking` (sync), chamado via `tokio::task::spawn_blocking` em `server.rs:173` — JoinHandle owned pelo tokio, sem raw `std::thread::spawn` | VERIFIED |
| Depth guard não lê do env do processo Tauri | `SpawnParams.depth: u32` — Claude pai passa o depth explicitamente na tool call; handler usa `p.depth` (não `std::env::var("TURBO_MCP_DEPTH")`); servidor injeta `TURBO_MCP_DEPTH=(depth+1)` no env do filho via `extra_env` | VERIFIED |

---

## Human Verification Required

Todas as 5 verdades observáveis têm código estruturalmente correto e wired, mas exigem verificação comportamental ao vivo com display Hyprland/Wayland e `claude` CLI no PATH:

### 1. Live MCP Handshake (ORCH-02)

**Test:** Iniciar o app; verificar no log de boot a mensagem `"MCP Streamable HTTP server listening on http://127.0.0.1:PORT/mcp"`
**Expected:** Log confirma servidor ouvindo; porta efêmera diferente de 0
**Why human:** Requer app em execução com display Wayland

### 2. spawn_agent Visível ao Claude Pai (ORCH-02)

**Test:** Criar um grupo (clicar "+ Novo grupo", selecionar pasta); no terminal do Claude pai, verificar que a tool `spawn_agent` aparece na lista de ferramentas disponíveis
**Expected:** Claude pai lista `spawn_agent` como MCP tool — confirma que `.mcp.json` foi escrito corretamente após health-check (D-02)
**Why human:** Requer display GUI + binário `claude` no PATH + interação com terminal

### 3. Filho Aparece no Canvas (ORCH-03 + GRP-03)

**Test:** Com app rodando, Claude pai chamar `spawn_agent("echo hello", "teste")` via tool use; observar o canvas
**Expected:** TerminalNode filho aparece em posição radial ao redor do pai, com label "teste" no cabeçalho, aresta animada pai→filho, contido dentro do GroupFrame
**Why human:** Verificação visual — parentId/extent estão corretos no código mas o rendering requer GUI

### 4. Call Bloqueante Completa com Output Correto (ORCH-03)

**Test:** Claude pai chama `spawn_agent("echo turbo-test", "test-label")`; aguardar retorno da tool call
**Expected:** Claude pai recebe "turbo-test" (com possível formatação de terminal) como resultado — a chamada completa sem timeout
**Why human:** Round-trip MCP completo: requer claude CLI + servidor MCP vivo + display

### 5. Concorrência: 3 Filhos Simultâneos (ORCH-07)

**Test:** Claude pai dispara 3 tool calls spawn_agent em paralelo (tarefas diferentes, ex: "echo A", "echo B", "echo C"); aguardar os 3 retornos
**Expected:** 3 TerminalNodes filho aparecem concorrentemente no canvas com labels distintos; cada chamador recebe o output correto sem mistura de resultados
**Why human:** Teste de concorrência real — verificação estrutural confirma isolamento (spawn_blocking independentes sem mutex) mas isolamento de outputs só pode ser provado ao vivo

---

## Conclusion

A phase 4 entregou a estrutura completa de orquestração MCP:
- Servidor rmcp Streamable HTTP embutido no tokio do Tauri (sem sidecar)
- Ordenação D-02 garantida em código: `block_on → McpState → create_group invocável → .mcp.json escrito`
- Evento `node_created` emitido ANTES do blocking call — canvas mostra filho imediatamente
- `addChildNode` cria filho com `parentId=groupId + extent=parent` (containment ReactFlow) + edge animado
- `run_in_pty_blocking` via `spawn_blocking` — sem raw thread leak, sem serialização entre calls concorrentes
- Depth guard lê de `SpawnParams.depth` (não do env do processo Tauri) — Phase 2 review fix aplicado
- Builds verdes: cargo build, tsc --noEmit, npm run build — todos EXIT 0

Verificação viva (round-trip com `claude` CLI + display Hyprland) é o único bloqueio restante, conforme antecipado pelo PLAN e SUMMARY da phase.

---

_Verified: 2026-08-05T14:45:00Z_
_Verifier: Claude (gsd-verifier)_
