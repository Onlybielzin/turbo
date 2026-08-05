---
phase: 2
title: MCP Spike (binário isolado)
wave: 1
depends_on: [1]
autonomous: true
requirements: [ORCH-01, ORCH-04, ORCH-05, ORCH-06]
files_modified:
  - spike/mcp-spike/Cargo.toml
  - spike/mcp-spike/src/main.rs
  - spike/mcp-spike/src/pty_runner.rs
  - spike/mcp-spike/src/server.rs
  - spike/mcp-spike/fake-agent.sh
  - spike/mcp-spike/README.md
---

# Phase 2 — PLAN: MCP Spike (binário isolado)

## Goal

Um binário standalone `turbo-mcp-spike` (FORA do Tauri) que prova a costura mais
arriscada do projeto: servidor MCP **Streamable HTTP** em `127.0.0.1` com a tool
`spawn_agent(task, label)` que roda `claude -p` num PTY, **bloqueia** até o filho
terminar e retorna o stdout — com **progress notifications ~10s** (evita timeout de
60s) e **depth guard** (bloqueia recursão). É de-risking: validar o loop antes de
portar pro Tauri na Phase 4.

## Design decisions (de 02-CONTEXT.md + research)

- Transporte: `rmcp` + `axum` Streamable HTTP em `127.0.0.1:PORT`. stdio impossível
  (o servidor recebe conexões de `claude` lançados à parte); SSE deprecado. `.mcp.json`
  usa `"type": "http"`.
- Leitura do PTY é síncrona (`portable-pty`) → thread dedicada; o loop acumula stdout
  para o retorno da tool E poderia streamar (no spike, só acumula).
- Progress: task async emite `notifications/progress` a cada ~10s enquanto o filho roda.
- Depth guard: profundidade via env `TURBO_MCP_DEPTH` que o filho herda; rejeitar `>= 2`.
- Concorrência: uma task async por chamada; outputs isolados por chamador.
- Custo/teste: modo `--fake` roda `fake-agent.sh` (dorme e ecoa) no lugar de `claude -p`
  para provar timeout/progress/concorrência **sem gastar tokens**; modo real usa `claude -p`.

## Artifacts this phase produces

- Crate `spike/mcp-spike` (bin `turbo-mcp-spike`)
- `spawn_agent` MCP tool; `PtyRunner::run_to_completion`; `--fake`/`--port`/`--depth-limit` CLI flags
- `fake-agent.sh` (stand-in de custo zero)

## Tasks

<task id="1" wave="1">
<title>Scaffold do crate do spike + dependências</title>
<read_first>
- app/src-tauri/src/lib.rs (padrão portable-pty: spawn_blocking, leitura em thread)
- .planning/research/STACK.md (rmcp features, versões; axum 0.8)
- .planning/research/PITFALLS.md (timeout 60s, stdio impossível, recursão)
</read_first>
<action>
Criar `spike/mcp-spike/Cargo.toml` (bin `turbo-mcp-spike`), deps:
`rmcp` com features `["server","macros","transport-streamable-http-server"]`,
`axum` 0.8, `tokio` (features full), `portable-pty` 0.9, `anyhow`, `serde`/`serde_json`,
`tracing` + `tracing-subscriber`, `clap` (flags).
Confirmar a versão real do rmcp com `cargo add rmcp --dry-run` / `cargo tree` (research
apontou discrepância 0.8 vs runtime 3.1.0 — pinar o que resolver).
Deixar `main.rs` mínimo compilando (parse de flags `--port`, `--fake`, `--depth-limit`,
init do tracing).
</action>
<acceptance_criteria>
- `cargo build` do crate passa (bin compila).
- `turbo-mcp-spike --help` lista as flags.
</acceptance_criteria>
<verify>cd spike/mcp-spike && cargo build && ./target/debug/turbo-mcp-spike --help</verify>
</task>

<task id="2" wave="1">
<title>PtyRunner: rodar um comando em PTY e capturar stdout até o exit</title>
<read_first>
- app/src-tauri/src/lib.rs (spawn/reader thread/reaping)
</read_first>
<action>
Em `src/pty_runner.rs`: `async fn run_to_completion(cmd, args, cwd, env) -> Result<String>`.
Abre PTY (`portable-pty`), spawna o comando, lê o master numa thread dedicada acumulando
bytes; usa um `oneshot`/`mpsc` para devolver o stdout completo quando o processo sai.
Preservar UTF-8 no final (decode lossy do buffer acumulado). Reap do child (sem zumbi).
No modo `--fake`, o comando é `bash fake-agent.sh <task>`; no modo real, `claude`
com args `["-p", task, "--output-format", "text", "--dangerously-skip-permissions"]`.
Criar `fake-agent.sh`: imprime progresso, `sleep` configurável (ex: 65s p/ testar timeout),
ecoa a task, sai 0.
</action>
<acceptance_criteria>
- Chamar run_to_completion com o fake retorna a saída ecoada.
- Não bloqueia o runtime tokio (leitura fora do executor async).
- `ps` não mostra processos órfãos após terminar.
</acceptance_criteria>
<verify>Teste unitário/integração que roda o fake e compara stdout; checar ausência de órfãos.</verify>
</task>

<task id="3" wave="1">
<title>Servidor MCP rmcp com a tool spawn_agent (bloqueante + progress)</title>
<read_first>
- .planning/research/STACK.md (rmcp StreamableHttpService, axum mount /mcp)
- .planning/research/ARCHITECTURE.md (handler spawn_agent, fan-out)
</read_first>
<action>
Em `src/server.rs`: montar `StreamableHttpService` do rmcp em `127.0.0.1:PORT` (`/mcp`)
via axum. Implementar a tool `spawn_agent { task: String, label: String }`:
1. Ler profundidade de `TURBO_MCP_DEPTH` (default 0). Se `>= depth_limit` (default 2),
   retornar erro de profundidade SEM spawnar (Task 4 exercita).
2. Spawnar `PtyRunner::run_to_completion` numa task async; enquanto roda, emitir
   `notifications/progress` a cada ~10s (via o Peer/RequestContext do rmcp) usando um
   `tokio::select!` entre um `interval(10s)` e o join handle do filho.
3. Ao terminar, retornar o stdout como conteúdo do resultado da tool (bloqueante).
Ao lançar o filho real, setar env `TURBO_MCP_DEPTH = depth+1` e (p/ Task 4) escrever um
`.mcp.json` `"type":"http"` apontando pro próprio servidor no cwd do filho.
</action>
<acceptance_criteria>
- Servidor sobe em 127.0.0.1:PORT e responde ao handshake MCP.
- spawn_agent("say hello","teste") no modo fake retorna a saída correta.
- Logs mostram progress notifications a cada ~10s numa tarefa de 65s.
</acceptance_criteria>
<verify>Rodar o bin com --fake; conectar um cliente MCP (ou `claude` com --mcp-config) e chamar a tool; inspecionar logs de progress.</verify>
</task>

<task id="4" wave="1">
<title>Depth guard + concorrência + harness de verificação</title>
<read_first>
- .planning/research/PITFALLS.md (recursão sem guard; timeout)
- .planning/ROADMAP.md (Phase 2 success criteria)
</read_first>
<action>
- Depth guard: script/teste que invoca spawn_agent com `TURBO_MCP_DEPTH=1` no filho e
  confirma que uma chamada de profundidade 2 é rejeitada sem criar neto.
- Concorrência: disparar 2 chamadas spawn_agent simultâneas (labels distintos, fakes com
  saídas distintas) e confirmar que cada chamador recebe o próprio output, sem mistura.
- Escrever `spike/mcp-spike/README.md`: como rodar em modo fake (custo zero) e em modo real
  (`claude` via `--mcp-config`), e como reproduzir os 4 critérios de sucesso.
</action>
<acceptance_criteria>
- Chamada depth 2 rejeitada, nenhum neto spawnado.
- 2 chamadas concorrentes retornam outputs corretos e isolados.
- README reproduz os critérios.
</acceptance_criteria>
<verify>Rodar o harness fake cobrindo os 4 critérios; anexar saída no README/summary.</verify>
</task>

## must_haves

truths:
  - "Um binário `turbo-mcp-spike` sobe um servidor MCP Streamable HTTP em 127.0.0.1 e responde spawn_agent retornando a saída de um `claude -p` (ou fake) — bloqueante. [ORCH-01, ORCH-04]"
  - "Uma tarefa >60s completa sem timeout: progress notifications aparecem nos logs a cada ~10s. [ORCH-05]"
  - "Duas chamadas spawn_agent concorrentes retornam outputs corretos por chamador, sem mistura. [ORCH-04]"
prohibitions:
  - statement: "Uma chamada spawn_agent com profundidade >= depth_limit (default 2) NÃO spawna um neto — é rejeitada com erro de profundidade. [ORCH-06]"
    status: resolved
    verification: "Harness com TURBO_MCP_DEPTH=1 no filho tentando chamar a tool; confirmar rejeição e ausência de processo neto."
  - statement: "O transporte NÃO usa stdio nem SSE — apenas Streamable HTTP em 127.0.0.1. [ORCH-01]"
    status: resolved
    verification: "Config/handshake usam type:http; grep no código não referencia stdio/sse server transport."

## Verification

Rodar tudo em modo `--fake` (custo zero) para os 4 critérios do ROADMAP Phase 2; depois um
smoke test opcional em modo real com `claude -p "say hello"` via `--mcp-config`. O código do
handler deve ficar modular (isolado do transporte) para portar limpo pro Tauri na Phase 4.

## Notes / research flags para a execução

- Confirmar a API exata de progress notification do rmcp na versão pinada (Peer/RequestContext).
- Confirmar se o `claude` instalado lê `.mcp.json` do cwd automaticamente ou exige flag
  (afeta como o filho "veria" a tool no teste de recursão real).
- Comportamento de auto-background de MCP tool calls no claude v2.1.212+ (após ~2min) —
  no spike, tarefas fake ficam abaixo disso; anotar para a Phase 4.
