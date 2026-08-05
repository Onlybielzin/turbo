# Phase 2: MCP Spike (binário isolado) - Context

**Gathered:** 2026-08-04
**Status:** Ready for planning

<domain>
## Phase Boundary

Um binário standalone `turbo-mcp-spike` (FORA do Tauri) que prova a costura mais arriscada do projeto: servidor MCP Streamable HTTP embutido + tool `spawn_agent` bloqueante que roda `claude -p` num PTY e retorna a saída, com progress notifications evitando timeout e depth guard bloqueando recursão. É um spike de de-risking, não código de produção — o objetivo é validar o loop antes de tocar em canvas ou integração Tauri.
</domain>

<decisions>
## Implementation Decisions

### Infra (travado por pesquisa — não são gray areas)
- **D-01:** Transporte MCP = Streamable HTTP em `127.0.0.1` via `rmcp` + axum. stdio é IMPOSSÍVEL (o servidor precisa aceitar conexões de processos `claude` lançados independentemente); SSE está deprecado. `.mcp.json` usa `"type": "http"`.
- **D-02:** `spawn_agent` bloqueante = handler async que `.await` o exit do `claude -p` (sem bloquear thread OS); retorna o stdout capturado.
- **D-03:** Progress notifications a cada ~10s durante a execução do filho — o cliente MCP do `claude` pai tem idle timeout de 60s; sem isso ele mata a tool call e deixa o filho órfão.
- **D-04:** Depth guard explícito no servidor — filhos herdam `.mcp.json` e podem chamar spawn_agent (netos); limitar profundidade (ex: rejeitar depth >= 2 no spike) para evitar explosão de custo.
- **D-05:** Chamadas concorrentes = uma task async por filho; outputs não podem se misturar entre chamadores.
- **D-06:** Flag de lançamento do `claude -p`: usar `--output-format text` (ou json) e `--dangerously-skip-permissions` no contexto controlado do spike; validar captura confiável do output final.

### Claude's Discretion
- Versão exata do `rmcp` (pesquisa notou discrepância 0.8 vs runtime 3.1.0 — confirmar com `cargo tree`).
- Estratégia de teste do binário (script que abre o servidor, faz a tool call, valida saída).
- Como simular depth 2 no spike (ex: um filho que tenta chamar spawn_agent).
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requisitos e roadmap
- `.planning/REQUIREMENTS.md` — ORCH-01, ORCH-04, ORCH-05, ORCH-06 (escopo desta fase)
- `.planning/ROADMAP.md` §"Phase 2" — success criteria (incl. tarefa >60s sem timeout, depth 2 rejeitado, 2 concorrentes)

### Pesquisa (crítico — costura novel)
- `.planning/research/STACK.md` — rmcp, transport-streamable-http-server, config `--mcp-config`, flags do `claude -p`
- `.planning/research/ARCHITECTURE.md` — handler spawn_agent, fan-out, seam mais arriscada (Layer 5)
- `.planning/research/PITFALLS.md` — timeout 60s, auto-background >2min (claude v2.1.212+), stdio impossível, recursão sem guard
- `.planning/research/SUMMARY.md` — por que o spike vem antes do canvas
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- O PtyManager e o padrão de spawn/leitura da Phase 1 são reusados para rodar o `claude -p` no PTY dentro do handler.

### Established Patterns
- fan-out read loop (Phase 1 D-04): aqui o acumulador de stdout vira o valor de retorno da tool.

### Integration Points
- O que este spike provar é portado para dentro do Tauri na Phase 4 (servidor MCP integrado). Manter o handler modular para facilitar o port.
</code_context>

<specifics>
## Specific Ideas

- Flag de pesquisa para o planner: confirmar o comportamento de auto-background de MCP tool calls no `claude` instalado (v2.1.212+ backgrounds após ~2min) e como isso afeta a semântica bloqueante do pai.
- Verificar se o `claude` instalado lê `.mcp.json` do cwd automaticamente ou exige flag.
</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope. Spike de infra, sem gray areas de visão do usuário.
</deferred>

---

*Phase: 2-MCP Spike (binário isolado)*
*Context gathered: 2026-08-04*
