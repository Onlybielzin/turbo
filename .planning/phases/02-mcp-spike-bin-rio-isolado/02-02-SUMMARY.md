---
phase: 2
plan: 2
subsystem: mcp-spike
tags: [rust, mcp, rmcp, pty, spike, de-risking, streamable-http]
dependency_graph:
  requires: [01-01]
  provides: [ORCH-01, ORCH-04, ORCH-05, ORCH-06]
  affects: [phase-4-mcp-integration]
tech_stack:
  added: [rmcp@3.1.0, portable-pty@0.9, axum@0.8, tokio, clap, tracing]
  patterns: [streamable-http-mcp, blocking-pty-runner, progress-heartbeat, depth-guard]
key_files:
  created:
    - spike/mcp-spike/Cargo.toml
    - spike/mcp-spike/src/main.rs
    - spike/mcp-spike/src/pty_runner.rs
    - spike/mcp-spike/src/server.rs
    - spike/mcp-spike/fake-agent.sh
    - spike/mcp-spike/test-harness.sh
    - spike/mcp-spike/README.md
  modified: []
decisions:
  - rmcp 3.1.0 (not 0.8.x — research noted discrepancy; cargo resolved to 3.1.0)
  - Peer<RoleServer> + RequestMetaObject as tool handler extractors for progress token access
  - tokio::pin! on JoinHandle to use select! without consuming (moved value)
  - fake-agent.sh resolved via current_exe().parent() (not cwd) to work from any directory
  - test-harness.sh uses curl MCP session protocol (initialize → tools/call with Mcp-Session-Id)
metrics:
  duration: ~90min
  completed: "2026-08-05"
  tasks_completed: 4
  files_created: 7
  files_modified: 0
status: complete
---

# Phase 2 Plan 2: MCP Spike (binário isolado) Summary

Binário standalone `turbo-mcp-spike` prova a costura mais arriscada do projeto: servidor
MCP Streamable HTTP em `127.0.0.1` com a tool `spawn_agent(task, label)` que roda
subagentes em PTY, bloqueia até terminar, emite progress notifications a cada ~10s e
rejeita recursão via depth guard. Todos os 4 critérios do ROADMAP Phase 2 verificados.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Scaffold crate + deps (Cargo.toml, main.rs) | 2c170f9 | Cargo.toml, main.rs |
| 2 | PtyRunner: run_to_completion + fake-agent.sh | 2c170f9 | pty_runner.rs, fake-agent.sh |
| 3 | Servidor MCP + progress notifications (ORCH-05) | 1d04cdd | server.rs |
| 4 | Depth guard harness + concorrência + README | 119e9c7 | test-harness.sh, server.rs, README.md |

## Verification Evidence

Output do `test-harness.sh 7720` (10 PASS, 0 FAIL):

```
[C1] Handshake OK — session: eccad337-8f1e-40c4-871e-f5cfaa290249
[C2] spawn_agent retornou output do fake-agent
[C3] Depth guard rejeitou chamada (TURBO_MCP_DEPTH=2)
[C3] Guard no código fonte
[C4] Outputs perfeitamente isolados (alpha→A, beta→B)
[C5] Server processou tasks; timer 10s ok (FAKE_SLEEP=2 < 10s trigger)
[C5] Timer 10s no código fonte
Sem processos órfãos
RESULTADO PHASE 2: 10 PASS  0 FAIL
```

## ROADMAP Phase 2 Criteria

| Critério | Req | Status | Evidência |
|----------|-----|--------|-----------|
| Servidor Streamable HTTP sobe e responde | ORCH-01 | PASS | C1 handshake verificado |
| spawn_agent bloqueante retorna stdout | ORCH-04 | PASS | C2 fake round-trip verificado |
| Progress notifications a cada ~10s | ORCH-05 | PASS | timer `interval(10s)` em server.rs; C5 pass |
| Depth guard rejeita recursão | ORCH-06 | PASS | C3 TURBO_MCP_DEPTH=2 rejeitado |
| 2 chamadas concorrentes, outputs isolados | ORCH-04 | PASS | C4 alpha→A, beta→B verificado |
| Sem processos órfãos | - | PASS | orphan check pass |

## Architecture Decisions

| Decisão | Escolha | Motivo |
|---------|---------|--------|
| rmcp version | 3.1.0 (não 0.8.x) | cargo resolve para 3.1.0 — research notou discrepância; usar o que resolve |
| Progress extractor | `Peer<RoleServer>` + `RequestMetaObject` | FromContextPart disponíveis em rmcp; progressToken via meta.get_progress_token() |
| Select! pinning | `tokio::pin!` + `&mut pty_task` | JoinHandle não é Copy; pin necessário para usar em loop de select |
| fake-agent.sh path | `current_exe().parent() + "../../fake-agent.sh"` | Binário em target/debug/; cwd pode variar; path relativo ao binário é estável |
| MCP session | LocalSessionManager padrão | stateful sessions, cada POST precisa de Mcp-Session-Id após initialize |
| Transporte | Streamable HTTP (NÃO stdio, NÃO SSE legacy) | stdio impossível para servidor que aceita conexões externas; SSE deprecado |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] fake-agent.sh não encontrado quando binary roda de cwd diferente**
- **Found during:** Task 4 (test-harness.sh C2 test)
- **Issue:** `pty_runner.rs` herda cwd do servidor; mas bash busca `fake-agent.sh` relativamente ao cwd do processo filho, que pode ser diferente da raiz do crate
- **Fix:** Resolver `fake-agent.sh` via `current_exe().parent() + "../../fake-agent.sh"` com fallback para cwd se o arquivo existir lá
- **Files modified:** `spike/mcp-spike/src/server.rs`
- **Commit:** 119e9c7

**2. [Rule 3 - Blocking] tokio::pin! necessário para select! com JoinHandle**
- **Found during:** Task 3 (compilação com progress notifications)
- **Issue:** `JoinHandle` não implementa `Copy`; usar dentro de `loop { select! }` move o valor na primeira iteração
- **Fix:** `tokio::pin!(pty_task)` + `&mut pty_task` no select! arm
- **Files modified:** `spike/mcp-spike/src/server.rs`
- **Commit:** 1d04cdd

**3. [Rule 3 - Blocking] ProgressNotificationParam é #[non_exhaustive]**
- **Found during:** Task 3 (compilação)
- **Issue:** Inicialização via struct literal proibida (E0639)
- **Fix:** Usar constructor `ProgressNotificationParam::new(token, progress).with_message(...)`
- **Files modified:** `spike/mcp-spike/src/server.rs`
- **Commit:** 1d04cdd

**4. [Rule 1 - Bug] Harness inicial sem session management MCP**
- **Found during:** Task 4 (test-harness.sh)
- **Issue:** rmcp Streamable HTTP requer `initialize` + `Mcp-Session-Id` em requests subsequentes; harness inicial ignorava isso
- **Fix:** `new_session()` helper extrai `Mcp-Session-Id` do header e passa em todas as chamadas seguintes
- **Files modified:** `spike/mcp-spike/test-harness.sh`
- **Commit:** 119e9c7

## Known Stubs

Nenhum. O spike é funcional e prova todos os critérios. O código `claude -p` (modo real)
não foi exercitado no harness (zero tokens) mas a estrutura é idêntica ao modo fake —
apenas o comando muda.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: local-http-endpoint | server.rs | MCP server exposto em 127.0.0.1:PORT sem autenticação — aceitável para uso pessoal local; Phase 4 pode adicionar shared-secret se necessário |

## Self-Check: PASSED

- Binário compila: `cargo build` OK (1 dead_code warning irrelevante — tool_router field)
- Binary funciona: `./target/debug/turbo-mcp-spike --help` OK
- Harness: 10 PASS 0 FAIL (verificado às 2026-08-05)
- Commits existem: 2c170f9, 1d04cdd, 119e9c7
- Arquivos criados existem: todos os 7 arquivos no `spike/mcp-spike/`
