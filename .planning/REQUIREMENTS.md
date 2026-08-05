# Requirements: Turbo — Canvas de Agentes

**Defined:** 2026-08-04
**Core Value:** Ver os subagentes do Claude trabalhando ao vivo — cada um no seu terminal visível no canvas — enquanto um Claude pai os orquestra e recebe os resultados de volta.

## v1 Requirements

Requisitos da release inicial. Cada um mapeia para fases do roadmap.

### Foundation (App + PTY)

- [x] **FND-01**: O app abre uma janela funcional no Linux/Wayland (Hyprland) sem tela preta (Wayland/DMABUF fix aplicado em `main()`)
- [x] **FND-02**: O backend spawna um processo em pty e lê sua saída sem bloquear o runtime async (leitura em `spawn_blocking`)
- [x] **FND-03**: A saída do pty chega ao frontend em streaming via Channel, preservando UTF-8/ANSI em fronteiras de chunk
- [x] **FND-04**: O frontend envia entrada de teclado ao pty (round-trip de digitação funciona)
- [x] **FND-05**: Redimensionar o terminal ajusta o pty (SIGWINCH) sem loop de resize
- [x] **FND-06**: Ao fechar o app, todos os processos/ptys filhos são encerrados (sem zumbis/órfãos)

### Terminal Node

- [ ] **TERM-01**: Cada nó do canvas renderiza um terminal xterm.js ligado a um pty por id
- [ ] **TERM-02**: O renderer padrão é canvas (addon-canvas); WebGL fica reservado só ao terminal em foco (evita esgotar contextos WebGL)
- [ ] **TERM-03**: O terminal mostra estado de saída do processo (rodando / terminou ok / terminou com erro)
- [ ] **TERM-04**: O usuário pode matar/limpar um nó-terminal individual pela UI

### Canvas

- [ ] **CANV-01**: Canvas infinito com pan e zoom fluidos
- [ ] **CANV-02**: Nós podem ser arrastados e reposicionados
- [ ] **CANV-03**: Arestas ligam pai→filho, tornando a árvore de spawn visível
- [ ] **CANV-04**: O canvas continua responsivo com múltiplos terminais ativos (sem morte de perf por re-render)

### Orchestration (MCP + spawn_agent)

- [ ] **ORCH-01**: O app hospeda um servidor MCP embutido via Streamable HTTP em 127.0.0.1 (stdio descartado; SSE deprecado)
- [ ] **ORCH-02**: O Claude pai é lançado configurado (`.mcp.json`/`--mcp-config`) enxergando a tool `spawn_agent`, e a config só é escrita após o servidor estar ouvindo
- [ ] **ORCH-03**: Chamar `spawn_agent(tarefa, label)` cria um novo nó-terminal filho no canvas rodando `claude -p` naquela tarefa
- [ ] **ORCH-04**: `spawn_agent` bloqueia até o filho terminar e retorna o output final do filho para o pai
- [ ] **ORCH-05**: `spawn_agent` emite progress notifications periódicas (~10s) para não estourar o idle timeout de 60s do cliente MCP do pai
- [ ] **ORCH-06**: O servidor impõe um guard de profundidade de recursão (limitar netos/bisnetos) para evitar explosão de custo
- [ ] **ORCH-07**: Chamadas `spawn_agent` concorrentes de um mesmo pai são suportadas (uma task async por filho)

### Groups / Multi-Project

- [ ] **GRP-01**: O usuário pode criar múltiplos grupos/projetos no mesmo canvas, cada um como um frame separado
- [ ] **GRP-02**: Cada grupo tem seu próprio diretório de trabalho (cwd) e seu próprio Claude pai lançado nesse cwd
- [ ] **GRP-03**: O servidor MCP associa cada chamada `spawn_agent` ao grupo do pai que chamou, atachando o filho no frame certo
- [ ] **GRP-04**: Grupos rodam simultaneamente e de forma isolada (um não interfere no outro)

## v2 Requirements

Adiado para o futuro. Rastreado, fora do roadmap atual.

### Persistence

- **PERS-01**: Salvar o layout do canvas (nós, arestas, grupos, cwd) em `~/.config/turbo/canvas.json`
- **PERS-02**: Restaurar o layout ao reabrir (PTYs começam novos; nós antigos mostram scrollback/estado "terminado")

### Interaction Plus

- **INT-01**: Reiniciar um nó-terminal reusando a mesma posição/aresta
- **INT-02**: Minimapa do canvas

## Out of Scope

Explicitamente excluído. Documentado para evitar scope creep.

| Feature | Reason |
|---------|--------|
| Instalador / empacotamento distribuível | Ferramenta pessoal, roda local no dev |
| Multiplataforma (Windows/macOS) | Só Linux/Arch/Hyprland por enquanto |
| Onboarding, docs de usuário, auth/multi-user | Uso pessoal single-user |
| Janelas nativas do Hyprland como terminais | Decidido: canvas próprio embutido |
| Modo híbrido (destacar agente em janela nativa) | Possível v2; fora do v1 |
| Fire-and-forget sem retorno pro pai | Descartado em favor de retorno bloqueante |
| Nós de shell genérico (npm/ssh/etc) | Foco em orquestrar Claude, não multiplexer genérico |
| Cloud sync | Local-only |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| FND-01 | Phase 1 | Complete |
| FND-02 | Phase 1 | Complete |
| FND-03 | Phase 1 | Complete |
| FND-04 | Phase 1 | Complete |
| FND-05 | Phase 1 | Complete |
| FND-06 | Phase 1 | Complete |
| ORCH-01 | Phase 2 | Pending |
| ORCH-04 | Phase 2 | Pending |
| ORCH-05 | Phase 2 | Pending |
| ORCH-06 | Phase 2 | Pending |
| TERM-01 | Phase 3 | Pending |
| TERM-02 | Phase 3 | Pending |
| TERM-03 | Phase 3 | Pending |
| TERM-04 | Phase 3 | Pending |
| CANV-01 | Phase 3 | Pending |
| CANV-02 | Phase 3 | Pending |
| CANV-03 | Phase 3 | Pending |
| CANV-04 | Phase 3 | Pending |
| GRP-01 | Phase 3 | Pending |
| GRP-02 | Phase 3 | Pending |
| GRP-04 | Phase 3 | Pending |
| ORCH-02 | Phase 4 | Pending |
| ORCH-03 | Phase 4 | Pending |
| ORCH-07 | Phase 4 | Pending |
| GRP-03 | Phase 4 | Pending |

**Coverage:**

- v1 requirements: 25 total
- Mapped to phases: 25
- Unmapped: 0

---
*Requirements defined: 2026-08-04*
*Last updated: 2026-08-04 after roadmap creation*
