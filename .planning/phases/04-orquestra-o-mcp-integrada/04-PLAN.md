---
phase: 4
title: Orquestração MCP Integrada
wave: 1
depends_on: [2, 3]
autonomous: true
requirements: [ORCH-02, ORCH-03, ORCH-07, GRP-03]
files_modified:
  - app/src-tauri/Cargo.toml
  - app/src-tauri/src/lib.rs
  - app/src-tauri/src/mcp/mod.rs
  - app/src-tauri/src/mcp/server.rs
  - app/src-tauri/src/mcp/spawn_agent.rs
  - app/src-tauri/src/groups.rs
  - app/src/canvas/store.ts
  - app/src/canvas/Canvas.tsx
  - app/src/canvas/layout.ts
---

# Phase 4 — PLAN: Orquestração MCP Integrada

## Goal

Fechar o loop: portar o servidor MCP provado no spike (Phase 2) pra **dentro do runtime
Tauri**, ligado ao `PtyManager` via `Arc`. O `claude` pai de cada grupo enxerga a tool
`spawn_agent` via `.mcp.json`; chamá-la **cria um TerminalNode filho no canvas**, com
**aresta pai→filho**, dentro do **GroupFrame correto**; a chamada bloqueia e retorna o
output do filho ao pai. Suporta chamadas concorrentes.

## Design decisions (de 04-CONTEXT.md)

- **Layout dos filhos:** em **leque/radial** ao redor do pai, com arestas pai→filho.
- **Ordem de wiring (crítica):** subir MCP → health-check (ouvindo) → escrever `.mcp.json`
  no cwd do grupo → lançar/reconfigurar o `claude` pai. Nunca escrever o config antes do
  servidor estar pronto.
- **Servidor no Tauri:** rmcp como task tokio no mesmo runtime, compartilhando
  `Arc<PtyManager>` com os comandos Tauri. Handler cria o pty filho + emite `node_created`
  pro front (no GroupFrame do pai) + bloqueia até o exit + retorna stdout.
- **Grupo↔chamada:** mapear cada conexão/chamada ao grupo do pai (porta por grupo ou id no
  `.mcp.json`) pra anexar o filho no frame certo (GRP-03).
- **Concorrência:** 3+ chamadas simultâneas do mesmo pai → 3 filhos, uma task async cada.
- Reusa (portando do spike): transporte Streamable HTTP, progress ~10s, depth guard.

## Artifacts this phase produces

- Módulo `mcp/` no app (server rmcp + handler spawn_agent), `groups.rs` (registro grupo↔porta/id)
- Evento Tauri `node_created` (payload: group_id, parent_pty_id, label) consumido pelo front
- `layout.ts` (posicionamento radial dos filhos) e wiring no store/Canvas

## Tasks

<task id="1" wave="1">
<title>Portar o servidor MCP do spike pra dentro do Tauri</title>
<read_first>
- spike/mcp-spike/src/server.rs, spike/mcp-spike/src/pty_runner.rs (Phase 2)
- app/src-tauri/src/lib.rs (PtyManager, builder, state)
- .planning/research/ARCHITECTURE.md (rmcp no Tauri, Arc<PtyManager>)
</read_first>
<action>
Criar `app/src-tauri/src/mcp/{mod,server,spawn_agent}.rs`. Adicionar deps rmcp/axum ao
Cargo.toml do app. No `run()`, subir o `StreamableHttpService` como task tokio (via
`tauri::async_runtime::spawn`) numa porta efêmera em `127.0.0.1`, compartilhando
`Arc<PtyManager>` (refatorar o state pra `Arc`). Guardar a porta/URL no state. Portar o
handler `spawn_agent` (bloqueante, progress ~10s, depth guard) do spike, mas usando o
`PtyManager` do app pra criar o pty filho.
</action>
<acceptance_criteria>
- App sobe; servidor MCP responde handshake em 127.0.0.1:PORT (log no boot).
- `cargo build` verde; nenhum órfão ao fechar.
</acceptance_criteria>
<verify>cargo build; rodar o app; curl/handshake MCP na porta logada.</verify>
</task>

<task id="2" wave="1">
<title>Registro de grupos + ordem de wiring do .mcp.json</title>
<read_first>
- app/src/canvas/GroupFrame.tsx, store.ts (Phase 3: criação de grupo)
- .planning/research/PITFALLS.md (ordem de escrita do .mcp.json)
</read_first>
<action>
`app/src-tauri/src/groups.rs`: registro grupo→(cwd, id/token). Comando `create_group(cwd)`:
1) garantir o MCP ouvindo (health-check), 2) escrever `.mcp.json` `"type":"http"` no cwd
apontando pro servidor (com o id do grupo p/ o handler saber o frame), 3) lançar o `claude`
pai naquele cwd via `pty_spawn` — o pai já enxerga `spawn_agent`. Ajustar o fluxo "Novo grupo"
do front (Phase 3) pra chamar esse comando em vez do spawn direto.
</action>
<acceptance_criteria>
- Pai lançado num GroupFrame enxerga a tool `spawn_agent` (.mcp.json escrito após health-check). [ORCH-02]
- Cada grupo tem id próprio associado à sua conexão/porta. [GRP-03]
</acceptance_criteria>
<verify>Criar grupo; no terminal do pai, confirmar que `claude` lista a tool spawn_agent.</verify>
</task>

<task id="3" wave="1">
<title>spawn_agent cria filho no canvas com aresta, dentro do GroupFrame do pai</title>
<read_first>
- app/src/canvas/store.ts, Canvas.tsx (nós/arestas/parentNode)
- .planning/research/ARCHITECTURE.md (node_created via evento)
</read_first>
<action>
No handler `spawn_agent`: ao criar o pty filho, emitir evento Tauri `node_created`
{ group_id, parent_pty_id, child_pty_id, label }. No front, listener adiciona um TerminalNode
filho **dentro do GroupFrame do grupo** (parentNode), posicionado em **leque radial** ao redor
do pai (`layout.ts`), e desenha a **aresta pai→filho**. O filho roda `claude -p <task>`; a tool
bloqueia e retorna o stdout ao pai (semântica do spike). Label da tarefa no cabeçalho do nó.
</action>
<acceptance_criteria>
- Chamar spawn_agent(task,label) cria um TerminalNode filho com o label no header e aresta pai→filho. [ORCH-03]
- O output final do filho volta pro pai (call bloqueante completa). [ORCH-04]
- O filho aparece dentro do GroupFrame do pai, não solto no canvas raiz. [GRP-03]
</acceptance_criteria>
<verify>Pai chama spawn_agent; ver o filho brotar em leque com aresta, rodar, terminar, e o resultado voltar.</verify>
</task>

<task id="4" wave="1">
<title>Concorrência + verificação end-to-end</title>
<read_first>
- .planning/ROADMAP.md (Phase 4 success criteria)
</read_first>
<action>
Garantir uma task async por chamada spawn_agent (sem serializar). Testar 3 chamadas
concorrentes do mesmo pai → 3 filhos simultâneos, cada um com output correto, todos no frame
do pai, em leque sem sobrepor. Smoke test com tarefas curtas (`claude -p "say hi"`) ou, p/
custo zero, o modo fake do spike apontado pro servidor integrado.
</action>
<acceptance_criteria>
- 3 chamadas concorrentes criam 3 filhos simultâneos com outputs corretos por chamador. [ORCH-07]
</acceptance_criteria>
<verify>Disparar 3 spawn_agent concorrentes; conferir 3 nós, outputs isolados, layout radial.</verify>
</task>

## must_haves

truths:
  - "O servidor MCP rmcp roda embutido no runtime Tauri (task tokio) compartilhando Arc<PtyManager>; o pai enxerga spawn_agent via .mcp.json escrito APÓS health-check. [ORCH-02]"
  - "Chamar spawn_agent cria um TerminalNode filho no canvas com label e aresta pai→filho, e o output volta pro pai (bloqueante). [ORCH-03, ORCH-04]"
  - "O filho spawnado aparece dentro do GroupFrame do pai, não no canvas raiz. [GRP-03]"
  - "3 chamadas spawn_agent concorrentes do mesmo pai criam 3 filhos simultâneos com outputs corretos por chamador. [ORCH-07]"

## Verification

Manual (display no Hyprland): criar grupo, pedir ao pai pra chamar spawn_agent (1 e depois 3
concorrentes), observar filhos em leque com arestas dentro do frame e o retorno ao pai.
Automático: `cargo build` + `npm run build` verdes. Reusar progress/depth-guard já provados
no spike (Phase 2). Cuidar do auto-background de MCP tool calls do claude v2.1.212+ (>2min):
se aparecer, documentar/lidar (a tarefa é a coordenação do pai, não bloqueia o canvas).

## Notes / flags para a execução

- Refatorar o `PtyManager` da Phase 1 para `Arc<PtyManager>` no state (o handler MCP e os
  comandos Tauri compartilham a mesma instância).
- Definir o mecanismo grupo↔chamada: porta por grupo (mais simples de isolar) OU um id no
  header/`.mcp.json` que o handler lê. Escolher na execução; porta-por-grupo é o default.
- Parâmetros do leque radial (raio, ângulo, reflow ao chegar mais filho) — ajustar por olho.
