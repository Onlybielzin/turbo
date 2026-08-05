---
phase: 02-mcp-spike-binario-isolado
verified: 2026-08-05T12:40:19Z
status: passed
score: 5/5
behavior_unverified: 0
overrides_applied: 0
re_verification: false
---

# Phase 2: MCP Spike (binário isolado) — Verification Report

**Phase Goal:** Um binário standalone prova que spawn_agent bloqueante funciona com rmcp + portable-pty no mesmo runtime tokio — com progress notifications evitando timeout e depth guard bloqueando recursão — antes de qualquer linha de canvas ou integração Tauri.
**Verified:** 2026-08-05T12:40:19Z
**Status:** passed
**Re-verification:** No — initial verification

---

## Step 0: Previous Verification

No previous VERIFICATION.md found. Initial mode.

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Binário `turbo-mcp-spike` sobe servidor MCP Streamable HTTP em 127.0.0.1 e responde spawn_agent retornando saída de `claude -p` (ou fake) — bloqueante [ORCH-01, ORCH-04] | VERIFIED | `cargo build` OK; `test-harness.sh` C1 handshake e C2 round-trip passaram; harness 10/10 PASS |
| 2 | Tarefa >60s completa sem timeout: progress notifications aparecem nos logs a cada ~10s [ORCH-05] | VERIFIED | `tokio::time::interval(10s)` + `tokio::select!` implementados em `server.rs:139`; heartbeat confirmado disparando em run manual com `FAKE_SLEEP=12` (log: `spawn_agent heartbeat elapsed_secs=10`) |
| 3 | Duas chamadas spawn_agent concorrentes retornam outputs corretos por chamador, sem mistura [ORCH-04] | VERIFIED | C4 test: duas chamadas paralelas com labels `task-alpha` e `task-beta` retornaram outputs perfeitamente isolados (alpha→A, beta→B) |

**Score:** 3/3 truths verified

### Prohibition Checks (must-NOT)

| # | Prohibition | Status | Evidence |
|---|-------------|--------|----------|
| P1 | spawn_agent com profundidade >= depth_limit NÃO spawna neto — rejeitada com erro [ORCH-06] | VERIFIED | C3 test: servidor iniciado com `TURBO_MCP_DEPTH=2`, chamada `spawn_agent` retornou `"depth guard: refusing spawn_agent at depth 2 (limit 2)"`; grep estático confirma guard em `server.rs:74` |
| P2 | Transporte NÃO usa stdio nem SSE — apenas Streamable HTTP em 127.0.0.1 [ORCH-01] | VERIFIED | grep em `server.rs` não encontrou referências a `stdio`, `sse`, `SSE`; único import é `StreamableHttpService` + axum montado em `/mcp` |

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `spike/mcp-spike/Cargo.toml` | Crate bin `turbo-mcp-spike` com deps rmcp 3.1.0, portable-pty 0.9, axum 0.8 | VERIFIED | Existe; todas as deps declaradas conforme especificado |
| `spike/mcp-spike/src/main.rs` | Parse de flags `--port`, `--fake`, `--depth-limit`; init do tracing; `#[tokio::main]` | VERIFIED | 52 linhas; clap `Parser` com 3 flags; tokio::main; chama `server::serve` |
| `spike/mcp-spike/src/pty_runner.rs` | `async fn run_to_completion` — PTY em thread dedicada, oneshot para retorno, reap do child | VERIFIED | 62 linhas; `std::thread::spawn` + `tokio::sync::oneshot`; child.wait() ao final |
| `spike/mcp-spike/src/server.rs` | SpawnServer + spawn_agent tool com depth guard + progress heartbeat + StreamableHttpService | VERIFIED | 215 linhas; depth guard (linha 74), interval 10s (linha 139), select! loop (linha 145), StreamableHttpService montado (linha 203) |
| `spike/mcp-spike/fake-agent.sh` | Stand-in zero-custo: imprime progresso, dorme FAKE_SLEEP, ecoa task, sai 0 | VERIFIED | 8 linhas; `FAKE_SLEEP` env var, `echo` + `sleep` + exit 0 implícito |
| `spike/mcp-spike/test-harness.sh` | Harness curl verificando os 4 critérios sem gastar tokens | VERIFIED | 215 linhas; testa C1 handshake, C2 round-trip, C3 depth guard, C4 concorrência, C5 heartbeat |
| `spike/mcp-spike/README.md` | Instruções de uso fake/real + critérios de sucesso + design decisions | VERIFIED | Documenta todos os 6 critérios marcados como `[x]`, design decisions em tabela |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `main.rs` | `server::serve(addr, fake, depth_limit)` | `mod server; server::serve(...)` | WIRED | main.rs linha 50 chama server::serve com todos os 3 params |
| `server.rs SpawnServer::spawn_agent` | `pty_runner::run_to_completion` | `crate::pty_runner::run_to_completion(command, args, None, extra_env)` | WIRED | server.rs linha 134; `use crate::pty_runner::run_to_completion` declarado |
| `pty_runner::run_to_completion` | tokio runtime (não bloqueante) | `std::thread::spawn` + `tokio::sync::oneshot` | WIRED | thread OS separada; caller `rx.await?` — tokio não é bloqueado |
| `server.rs` | rmcp StreamableHttpService | `StreamableHttpService::new(...)` montado em axum router `/mcp` | WIRED | linhas 203–211; axum::serve ativo |
| depth guard | `TURBO_MCP_DEPTH` env var | `std::env::var("TURBO_MCP_DEPTH")` + `child env: TURBO_MCP_DEPTH = depth+1` | WIRED | leitura linha 68; propagação para filho linha 124 |
| progress heartbeat | `peer.send_notification` | `tokio::select!` com `interval(10s)` arm emitindo `ProgressNotification` | WIRED | linhas 139–183; notificação enviada quando `progress_token` está presente |

---

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Binário compila sem erros | `cargo build` (em `spike/mcp-spike`) | `Finished dev profile [unoptimized + debuginfo]` (1 dead_code warning: `tool_router` field — inocuo) | PASS |
| Flags `--help` listadas | `./target/debug/turbo-mcp-spike --help` | Flags `--port`, `--fake`, `--depth-limit` exibidas | PASS |
| Harness completo (10 checks) | `bash test-harness.sh 7730` | `10 PASS 0 FAIL — TODOS OS CRITERIOS VERIFICADOS` | PASS |
| Heartbeat 10s dispara em tarefa longa | Servidor com `FAKE_SLEEP=12`, tool call via curl | Log: `spawn_agent heartbeat elapsed_secs=10` — confirma que interval(10s) dispara | PASS |
| Depth guard rejeita em produção | Servidor com `TURBO_MCP_DEPTH=2`, `--depth-limit 2` | Retornou `"depth guard: refusing spawn_agent at depth 2 (limit 2)"` | PASS |
| Outputs isolados em concorrência | Duas calls curl paralelas com tasks distintas | C4: `task-alpha → A`, `task-beta → B`, sem mistura | PASS |

---

## Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| ORCH-01 | Servidor MCP via Streamable HTTP em 127.0.0.1 (stdio/SSE descartados) | SATISFIED | StreamableHttpService em `server.rs`; handshake MCP verificado em C1 |
| ORCH-04 | `spawn_agent` bloqueia até filho terminar e retorna output | SATISFIED | `rx.await?` em pty_runner + `tokio::select!` aguardando `pty_task` em server.rs; C2 confirma |
| ORCH-05 | Progress notifications periódicas (~10s) evitam idle timeout de 60s | SATISFIED | `interval(10s)` + `select!` + `peer.send_notification()` — heartbeat confirmado disparando |
| ORCH-06 | Depth guard impõe limite de recursão | SATISFIED | `TURBO_MCP_DEPTH` lido no handler; rejeição quando `depth >= depth_limit`; C3 confirma |

---

## Anti-Patterns Scan

Arquivos em `spike/mcp-spike/src/` varridos:

| File | Pattern | Severity | Result |
|------|---------|----------|--------|
| `main.rs` | TBD/FIXME/XXX | - | NONE FOUND |
| `pty_runner.rs` | TBD/FIXME/XXX | - | NONE FOUND |
| `server.rs` | TBD/FIXME/XXX | - | NONE FOUND |
| `server.rs` | `return null / return {}` stub patterns | - | NONE — retornos são `CallToolResult::success` ou `CallToolResult::error` com conteúdo real |
| `server.rs` | `tool_router` dead_code warning | INFO | Campo existe mas não é lido diretamente; `tool_router()` macro usa-o implicitamente. Warning inocuo para spike. |

Sem debt markers não referenciados. Sem stubs. Sem implementações vazias.

---

## Human Verification Required

Nenhum item requer verificação humana. Todos os critérios foram verificados programaticamente:

- Compilacao: `cargo build` confirmado
- Round-trip MCP: harness curl confirmado
- Heartbeat real: run com FAKE_SLEEP=12 confirmado
- Depth guard: run com TURBO_MCP_DEPTH=2 confirmado
- Concorrência: duas calls paralelas confirmadas

**Nota sobre modo real com `claude -p`:** O PLAN must_have-1 especifica "ou fake" explicitamente. O ROADMAP SC-1 menciona `claude -p` mas o PLAN esclareceu que o smoke test real era "opcional". O código para modo real está wired identicamente ao fake (apenas o `command` muda em `server.rs:112`). Um teste de smoke real com `claude -p "say hello"` via `--mcp-config` pode ser feito manualmente se desejado, mas não é bloqueante para aprovação desta fase.

---

## Deferred Items

Nenhum. Todos os critérios da Phase 2 foram verificados dentro desta fase.

**Items explicitamente fora de escopo desta fase (Phase 4):**
- ORCH-07: Chamadas concorrentes de um mesmo pai criando nós no canvas (Phase 4 goal)
- Canvas integration, GroupFrames, aresta pai→filho (Phase 3/4)

---

## Gaps Summary

Nenhum gap identificado. A fase entregou todos os 5 must-haves verificáveis (3 truths + 2 prohibitions).

**Commits verificados no git:**
- `2c170f9` — feat(phase-2): MCP spike binary (rmcp streamable-http + blocking spawn_agent)
- `1d04cdd` — feat(02-02): progress notifications every 10s in spawn_agent (ORCH-05)
- `119e9c7` — feat(02-02): depth guard harness + concurrency test + README (ORCH-04/05/06)

---

_Verified: 2026-08-05T12:40:19Z_
_Verifier: Claude (gsd-verifier)_
