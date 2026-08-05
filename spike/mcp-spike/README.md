# turbo-mcp-spike (Phase 2)

Binário isolado (fora do Tauri) que prova a costura mais arriscada do Turbo: um
servidor MCP **Streamable HTTP** em `127.0.0.1` com a tool `spawn_agent(task, label)`
que roda um subagente `claude -p` num PTY, **bloqueia** até terminar e retorna o
output. Depth guard bloqueia recursão. Modo `--fake` testa tudo sem gastar tokens.

## Rodar

    cargo build
    ./target/debug/turbo-mcp-spike --fake --port 7717   # modo fake (custo zero)
    ./target/debug/turbo-mcp-spike --port 7717           # modo real (usa `claude -p`)

Flags: `--port <N>` (default 7717), `--fake`, `--depth-limit <N>` (default 2).

## Testar com o claude (modo real)

Escreva um `.mcp.json` no cwd apontando pro servidor e rode o claude:

    { "mcpServers": { "turbo": { "type": "http", "url": "http://127.0.0.1:7717/mcp" } } }

Depois peça ao claude pra chamar a tool `spawn_agent`.

## Critérios de sucesso (ROADMAP Phase 2)

- [x] Servidor Streamable HTTP sobe em 127.0.0.1 e responde no /mcp (verificado: boot + HTTP 406 sem handshake).
- [x] spawn_agent bloqueante roda o comando em PTY e retorna stdout (fake e real).
- [x] Depth guard: rejeita chamadas com TURBO_MCP_DEPTH >= depth-limit sem spawnar neto.
- [ ] **PENDENTE:** progress notifications a cada ~10s (ORCH-05). Ainda NÃO implementado —
      a tool bloqueia sem emitir progress, então tarefas reais >60s podem estourar o idle
      timeout do cliente. Tarefas fake curtas (<60s) passam. Implementar via o
      RequestContext/Peer do rmcp antes de considerar a Phase 2 100%.

## Arquitetura (portada pro Tauri na Phase 4)

- `pty_runner.rs` — roda um comando em PTY, leitura em thread dedicada (não bloqueia o
  tokio), retorna stdout completo no exit via oneshot. Sem zumbis.
- `server.rs` — rmcp 3.1.0 `StreamableHttpService` + axum; tool `spawn_agent` com depth guard.
- `main.rs` — flags (clap) + tracing.
