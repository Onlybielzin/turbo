# Phase 1: Foundation — Tauri + PTY - Context

**Gathered:** 2026-08-04
**Status:** Ready for planning

<domain>
## Phase Boundary

Entrega a janela Tauri funcional no Linux/Wayland (Hyprland) e o bridge PTY completo no backend Rust: spawnar, ler (streaming), escrever (input), redimensionar (SIGWINCH) e matar processos PTY de forma não-bloqueante e sem órfãos. Sem canvas, sem MCP, sem xterm ainda — apenas provar o round-trip PTY↔frontend com uma UI mínima de teste.
</domain>

<decisions>
## Implementation Decisions

### Infra (travado por pesquisa — não são gray areas)
- **D-01:** `WEBKIT_DISABLE_DMABUF_RENDERER=1` deve ser setado dentro de `main()` ANTES do `tauri::Builder`, não como env manual (senão janela preta no Hyprland/Wayland). Ver PITFALLS.md.
- **D-02:** Leitura do PTY roda em `tokio::task::spawn_blocking` (portable-pty é síncrono; ler direto em async congela o executor).
- **D-03:** Streaming de saída do PTY para o frontend via `tauri::ipc::Channel` (ordenado, tipado, eficiente para alta frequência) — NÃO via `emit` de evento para bytes. Eventos ficam só para topologia (node_created etc.).
- **D-04:** Fan-out do read loop: uma leitura alimenta ao mesmo tempo o Channel do frontend E um acumulador de stdout (para o retorno futuro do spawn_agent na Phase 4). Usar mpsc com drop-on-full para backpressure no stream do frontend.
- **D-05:** Preservar UTF-8/ANSI em fronteiras de chunk (não cortar multibyte no meio).
- **D-06:** Cleanup de órfãos ao fechar o app — matar todos os PTYs filhos no shutdown.

### Claude's Discretion
- Escolha final entre `portable-pty` (nomeado no PROJECT.md) vs `pty-process` (async-native) — o researcher/planner decide; a pesquisa levantou os dois. Default: `portable-pty` + `spawn_blocking` conforme STACK.md.
- Estrutura do PtyManager (map id→pty, DashMap ou Mutex<HashMap>).
- UI mínima de teste desta fase (um único terminal HTML cru serve; xterm entra na Phase 3).
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Projeto e requisitos
- `.planning/PROJECT.md` — visão, stack e decisões-chave
- `.planning/REQUIREMENTS.md` — FND-01..06 (escopo desta fase)
- `.planning/ROADMAP.md` §"Phase 1" — success criteria

### Pesquisa (crítico)
- `.planning/research/STACK.md` — Tauri v2, portable-pty, Channel API, versões
- `.planning/research/ARCHITECTURE.md` — PtyManager, bridge Channel+eventos, fan-out read loop
- `.planning/research/PITFALLS.md` — Wayland/DMABUF fix, spawn_blocking, órfãos, UTF-8 chunk boundaries, SIGWINCH loop
- `.planning/research/SUMMARY.md` — ordem de build acordada
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Nenhum ainda — greenfield. Esta é a primeira fase com código.

### Established Patterns
- Nenhum código existente; os padrões desta fase (PtyManager, Channel bridge) viram a base reusada pelas fases 3 e 4.

### Integration Points
- O PtyManager e o Channel bridge desta fase são consumidos por TerminalNode (Phase 3) e pelo handler MCP spawn_agent (Phase 4).
</code_context>

<specifics>
## Specific Ideas

- Ambiente-alvo concreto: Arch/Omarchy, Hyprland, Wayland, 3 monitores. Testar `cargo tauri dev` nesse setup sem exports manuais.
- Critério de aceite de órfãos: após fechar o app, `ps aux | grep claude | grep -v grep` retorna zero.
</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope. Fase de infra pura, sem gray areas de visão do usuário.
</deferred>

---

*Phase: 1-Foundation — Tauri + PTY*
*Context gathered: 2026-08-04*
