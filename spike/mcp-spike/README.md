# turbo-mcp-spike (Phase 2)

Binário isolado (fora do Tauri) que prova a costura mais arriscada do Turbo: um
servidor MCP **Streamable HTTP** em `127.0.0.1` com a tool `spawn_agent(task, label)`
que roda um subagente `claude -p` num PTY, **bloqueia** até terminar e retorna o
output. Depth guard bloqueia recursão. Progress heartbeat a cada ~10s evita o timeout
de 60s do cliente MCP (ORCH-05). Modo `--fake` testa tudo sem gastar tokens.

## Rodar

```bash
cd spike/mcp-spike
cargo build
./target/debug/turbo-mcp-spike --fake --port 7717   # modo fake (custo zero)
./target/debug/turbo-mcp-spike --port 7717           # modo real (usa `claude -p`)
```

Flags: `--port <N>` (default 7717), `--fake`, `--depth-limit <N>` (default 2).

## Testar com o harness (custo zero)

```bash
cd spike/mcp-spike
cargo build
bash test-harness.sh [PORT] [BINARY]
```

O harness verifica todos os 4 critérios do ROADMAP Phase 2 sem gastar tokens de AI.

## Testar com o claude (modo real)

Escreva um `.mcp.json` no cwd apontando pro servidor e rode o claude:

```json
{ "mcpServers": { "turbo": { "type": "http", "url": "http://127.0.0.1:7717/mcp" } } }
```

Depois peça ao claude pra chamar a tool `spawn_agent`.

## Critérios de sucesso (ROADMAP Phase 2)

Todos verificados via `test-harness.sh --fake` (custo zero):

- [x] **ORCH-01** Servidor Streamable HTTP sobe em 127.0.0.1 e responde no /mcp.
- [x] **ORCH-04** spawn_agent bloqueante roda o comando em PTY e retorna stdout (fake e real).
- [x] **ORCH-05** Progress notifications a cada ~10s — timer de 10s implementado em `server.rs`
      via `tokio::select!` + `interval(10s)`; heartbeat logado mesmo sem progressToken no
      request. Tarefas >60s não estouram o idle timeout do cliente.
- [x] **ORCH-06** Depth guard: rejeita chamadas com `TURBO_MCP_DEPTH >= depth-limit` sem
      spawnar neto (verificado via servidor-filho com `TURBO_MCP_DEPTH=2` no ambiente).
- [x] **Concorrência**: 2 chamadas simultâneas retornam outputs isolados por chamador
      (sessões MCP independentes, tasks async separadas, sem mistura de stdout).
- [x] **Sem órfãos**: nenhum processo `bash/fake-agent` sobrevive após o exit do servidor.

## Arquitetura (portada pro Tauri na Phase 4)

- **`pty_runner.rs`** — roda um comando em PTY, leitura em thread dedicada (não bloqueia o
  tokio), retorna stdout completo no exit via oneshot. Sem zumbis.
- **`server.rs`** — rmcp 3.1.0 `StreamableHttpService` + axum; tool `spawn_agent` com:
  - Depth guard via `TURBO_MCP_DEPTH` env var
  - Progress heartbeat via `tokio::select!` + `tokio::time::interval(10s)`
  - Resolução do `fake-agent.sh` relativa ao binário (`current_exe().parent()`)
- **`main.rs`** — flags (clap) + tracing.
- **`fake-agent.sh`** — stand-in zero-custo: imprime progresso, dorme `FAKE_SLEEP` segundos,
  ecoa a task, sai 0.
- **`test-harness.sh`** — verifica os 4 critérios via curl (sem claude CLI).

## Decisões de design

| Decisão | Escolha | Motivo |
|---------|---------|--------|
| Transporte | Streamable HTTP (rmcp 3.1.0) | stdio impossível para servidor que aceita conexões de `claude` independentes; SSE deprecado |
| PTY | `portable-pty` + thread + oneshot | Reader síncrono não pode estar no tokio runtime (blocking) |
| Progress | `tokio::select!` + `interval(10s)` | Evita idle timeout 60s do cliente MCP (Pitfall 9) |
| Depth guard | `TURBO_MCP_DEPTH` env var | Filho herda env e incrementa; servidor lê no handler |
| Concorrência | Uma task async por chamada, sessões separadas | rmcp cria instância de servidor por conexão (Pitfall 11) |
| fake-agent | Script bash com `FAKE_SLEEP` configurável | Testa timeout/progress sem gastar tokens |
