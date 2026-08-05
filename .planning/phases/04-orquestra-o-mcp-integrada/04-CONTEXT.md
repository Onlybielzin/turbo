# Phase 4: Orquestração MCP Integrada - Context

**Gathered:** 2026-08-04
**Status:** Ready for planning

<domain>
## Phase Boundary

Fecha o loop: porta o servidor MCP (provado no spike da Phase 2) para DENTRO do runtime Tauri, ligado ao PtyManager via `Arc`. O Claude pai de cada grupo enxerga a tool `spawn_agent` via `.mcp.json`; chamá-la cria um TerminalNode filho visível no canvas, com aresta pai→filho, dentro do GroupFrame correto do pai; a chamada bloqueia e retorna o output do filho ao pai. Suporta chamadas concorrentes.
</domain>

<decisions>
## Implementation Decisions

### Layout dos filhos (DECIDIDO pelo usuário)
- **D-01:** Filhos criados pelo pai se posicionam **em leque/radial ao redor do pai** no canvas, com arestas pai→filho. (Nota de perf: se ficar apertado com muitos filhos, o planner pode degradar graciosamente, mas o default visual é radial.)

### Integração MCP (travado por pesquisa)
- **D-02:** Ordem crítica de wiring do grupo: subir o servidor MCP → health-check (servidor ouvindo) → SÓ ENTÃO escrever o `.mcp.json` no cwd do grupo → lançar/reconfigurar o Claude pai. Escrever o `.mcp.json` antes do servidor estar pronto quebra a descoberta da tool.
- **D-03:** Servidor MCP rmcp roda como task tokio no mesmo runtime do Tauri, compartilhando `Arc<PtyManager>` com os comandos Tauri. O handler spawn_agent cria o pty filho + emite evento "node_created" para o frontend (anexado ao GroupFrame do pai) + bloqueia até o exit + retorna stdout.
- **D-04:** Associação grupo↔chamada: o servidor precisa mapear cada conexão/chamada spawn_agent ao grupo do pai que chamou (ex: porta/token por grupo, ou id no `.mcp.json`), para anexar o filho no frame certo (GRP-03).
- **D-05:** Concorrência: 3+ chamadas spawn_agent simultâneas do mesmo pai criam 3 nós filhos ao mesmo tempo, cada uma sua task async, outputs corretos por chamador.

### Claude's Discretion
- Mecanismo exato de mapear conexão→grupo (porta por grupo vs identificador no config vs header).
- Parâmetros do leque radial (raio, ângulo, como reflow quando chega mais filho).
- Formato do retorno ao pai (texto completo vs resumo) — default: output final do filho conforme ORCH-04; considerar truncamento se estourar contexto.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requisitos e roadmap
- `.planning/REQUIREMENTS.md` — ORCH-02, ORCH-03, ORCH-07, GRP-03 (escopo desta fase). Também herda ORCH-01/04/05/06 provados na Phase 2.
- `.planning/ROADMAP.md` §"Phase 4" — success criteria (incl. `.mcp.json` após health-check, aresta pai→filho, 3 concorrentes, filho dentro do GroupFrame)

### Fase anterior (o spike a portar)
- `.planning/phases/02-mcp-spike-bin-rio-isolado/02-CONTEXT.md` — decisões do spike (transporte, progress notifications, depth guard) que entram aqui
- `.planning/phases/03-canvas-terminal-nodes-grupos/03-CONTEXT.md` — GroupFrame/cwd/auto-launch do pai que esta fase estende

### Pesquisa (crítico)
- `.planning/research/ARCHITECTURE.md` — rmcp embutido no Tauri, Arc<PtyManager>, ordem de wiring do `.mcp.json`, seam mais arriscada
- `.planning/research/PITFALLS.md` — timeout/auto-background, recursão, ordem de escrita do `.mcp.json`
- `.planning/research/STACK.md` — config `.mcp.json` `"type":"http"`, `--mcp-config`, flags do claude
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Phase 2 spike: todo o handler spawn_agent (bloqueante, progress, depth guard) — portar para dentro do Tauri.
- Phase 1: PtyManager (via Arc) para os filhos.
- Phase 3: GroupFrame/cwd + evento node_created + arestas ReactFlow (aqui geradas automaticamente pai→filho).

### Established Patterns
- Eventos Tauri para topologia (node_created) — o handler MCP emite para o frontend anexar o nó no frame do pai.
- Channel-per-pty para streaming da saída do filho ao vivo enquanto o handler acumula stdout para o retorno.

### Integration Points
- Esta é a fase de convergência: une PtyManager (F1), spawn_agent handler (F2) e canvas/grupos (F3) no loop completo.
</code_context>

<specifics>
## Specific Ideas

- Success criteria observável: lançar o pai num GroupFrame, pedir a ele para chamar spawn_agent, ver o filho brotar em leque com aresta, o filho rodar ao vivo, terminar, e o resultado voltar ao pai — tudo dentro do frame certo.
</specifics>

<deferred>
## Deferred Ideas

- Spawn manual de filho pelo usuário (sem passar pelo pai) — possível conveniência futura, fora do escopo do loop pai→filho do v1.
- Reflow/auto-layout inteligente de árvores grandes — além do leque radial simples do v1.
</deferred>

---

*Phase: 4-Orquestração MCP Integrada*
*Context gathered: 2026-08-04*
