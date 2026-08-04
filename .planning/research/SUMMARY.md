# Project Research Summary

**Project:** Turbo — Canvas de Agentes
**Domain:** Personal Linux desktop app — infinite canvas of live Claude agent terminals with visual orchestration
**Researched:** 2026-08-04
**Confidence:** MEDIUM (stack bem documentado; costura MCP-em-Tauri é nova o suficiente para requerer spike)

## Executive Summary

Turbo é um cockpit visual de agentes: um canvas infinito estilo Figma onde cada nó é um terminal vivo rodando uma instância `claude`. Um Claude pai orquestra filhos via MCP tool `spawn_agent`, que cria novos nós visíveis no canvas e retorna o output final ao pai. A pesquisa confirma que o stack decidido (Tauri v2 + React + xterm.js + @xyflow/react + rmcp) é a escolha correta e está bem fundamentado — cada componente tem um precedente de produção claro. O padrão arquitetural dominante é: PTY gerenciado em Rust com leitura em `spawn_blocking`, saída em fan-out para Channel (display) e buffer acumulador (retorno MCP), canvas ReactFlow com TerminalNodes memoizados, e servidor MCP rmcp rodando no mesmo runtime tokio do Tauri.

O risco principal não está na stack em si, mas na **costura MCP-em-Tauri**: o `spawn_agent` bloqueia o tool call do pai enquanto um processo filho corre por minutos, e o timeout idle de 60 s do cliente MCP mata a chamada se nenhum progress notification for enviado. Crianças herdam `.mcp.json` e podem spawnar netos — sem depth guard, uma tarefa mal-formulada gera recursão exponencial. Esses dois problemas devem ser resolvidos num spike isolado **antes** de qualquer trabalho de canvas, para não contaminar a arquitetura com hacks de última hora.

A ordem de construção consensuada pelos quatro pesquisadores é: fundação PTY → spike da costura MCP (binário isolado) → canvas + TerminalNode → abstração de grupo/cwd → servidor MCP + spawn_agent integrado → persistência (depois). Dois problemas de plataforma têm solução de uma linha mas travam tudo se esquecidos: `WEBKIT_DISABLE_DMABUF_RENDERER=1` deve ser setado em `main()` antes do builder Tauri (blank window NVIDIA/Wayland), e o renderer padrão do xterm deve ser `@xterm/addon-canvas` para todos os nós, reservando WebGL apenas para o nó focado (limite ~8–16 contextos).

---

## Key Findings

### Recommended Stack

O stack é direto e bem mapeado. Tauri v2.10.1 como shell Rust, React 19 + TypeScript 5 + Vite 6 no frontend, @xyflow/react 12.11.2 para o canvas (única biblioteca React com custom nodes DOM first-class), @xterm/xterm 6.0.0 + addons `@xterm/*` (escopo obrigatório — `xterm` sem escopo está deprecated), Zustand 5 com slice pattern para estado do canvas, portable-pty 0.9 no Rust para PTY (não `tauri-plugin-pty`, que está em 0.1.1 e sem exit detection), rmcp 0.8 com feature `transport-streamable-http-server` para o servidor MCP embutido.

**Core technologies:**

- **Tauri v2** + tokio: shell Rust, PTY management, IPC bridge, MCP server host — mais leve que Electron; runtime único para tudo
- **@xyflow/react 12.11.2**: canvas infinito com custom nodes DOM — única opção viável (tldraw é shape-canvas; Konva é pure canvas sem DOM)
- **@xterm/xterm 6.0.0** + `@xterm/addon-canvas` (default) / `addon-webgl` (só no nó focado): terminal emulator nos nós — imperativo via `useRef`, sem wrapper React
- **portable-pty 0.9**: PTY em Rust, sync internamente — leitura OBRIGATORIAMENTE em `spawn_blocking`; produção-grade (WezTerm)
- **rmcp 0.8** com `transport-streamable-http-server`: servidor MCP embutido no tokio do Tauri; SSE está deprecated no spec MCP (2025-03-26); stdio é impossível nesta arquitetura; Streamable HTTP em `127.0.0.1` é o único transporte correto
- **Zustand 5** + immer: estado do canvas (nodes, edges, groups) — slice por domínio; seletores por nó evitam re-render cascata
- **DashMap 6** (Rust): mapa concorrente `pty_id → PtyEntry` sem lock explícito em leituras

**Decisões de versão críticas:**
- `@xterm/*` addons devem ter major version igual ao core (6.x)
- `rmcp` pina `axum 0.8` — não colocar outra versão de axum no Cargo.toml
- `portable-pty` é sync; nunca chamar `.read()` dentro de fn async sem `spawn_blocking`
- `.mcp.json` deve usar `"type": "http"` (não `"sse"` — deprecated; não `"streamable-http"` — alias aceito mas verbose)

### Expected Features

A pesquisa de features confirmou e refinou o escopo do PROJECT.md sem adicionar anti-features.

**Must have (table stakes — sem estes o conceito não funciona):**
- Canvas infinito com pan, zoom e drag de nós (react-flow out-of-the-box)
- TerminalNode ao vivo: PTY streaming + input de teclado + indicador de status (running/done/error)
- Servidor MCP embutido expondo `spawn_agent(task, label)` via HTTP Streamable em localhost
- `spawn_agent` bloqueante: cria nó filho no canvas, roda `claude -p`, retorna output final ao pai
- Arestas pai→filho desenhadas automaticamente no spawn
- Grupos/frames por projeto: cwd separado, Claude pai próprio
- Kill/cleanup de PTYs no fechamento do app (sem zombies)
- Node resize com PTY resize em sincronia (addon-fit + `master.resize`)
- Label da tarefa no cabeçalho do nó (do argumento `label` do spawn_agent)

**Should have (differentiators — fazem o Turbo ser o Turbo):**
- Spawn-tree visualization: arestas desenhadas em tempo real conforme o pai spawna filhos
- GroupFrame: frame ReactFlow contendo pai + filhos, com label do cwd
- Scrollback buffer configurável (default 200 linhas para nós filhos, mais para o pai interativo)

**Defer (v1.x após validação diária):**
- Canvas persistence (save/restore layout em JSON via ReactFlow.toObject())
- Minimap (quando canvas tiver >10 nós regularmente)
- Edge color por status do filho
- Interim streaming do resultado do filho para o pai (dual-channel complexo, v2+)

**Anti-features confirmados (não construir em v1):**
- Shell terminals genéricos (não é multiplexer)
- Multi-user/sync (ferramenta pessoal local)
- Fire-and-forget (descartado em PROJECT.md)
- Auto-layout DAG (briga com posicionamento manual do usuário)

### Architecture Approach

A arquitetura tem três camadas com boundaries rígidas: React frontend (WebView) ↔ Rust backend (Tauri core) ↔ OS processes. Regra cardinal: React nunca fala com processos OS; Rust nunca importa React; MCP server nunca fala com o frontend diretamente — só via `AppHandle::emit()`. O PtyManager centraliza todo estado de processos em Rust, exposto ao frontend apenas via comandos Tauri tipados e Channel por pty_id. O McpServer compartilha um `Arc<AppState>` com o PtyManager via método async direto (mesmo processo, zero serialização extra).

**Major components:**

1. **PtyManager** (Rust) — Dono exclusivo de handles pty/processo; spawn/read/write/kill/resize; fan-out para Channel (display) e `stdout_buf` (retorno MCP)
2. **Tauri IPC Bridge** — Único cruzamento legal JS↔Rust; comandos tipados + Channel por pty_id para bytes (nunca events broadcast para bytes)
3. **McpServer** (rmcp, Rust) — Servidor Streamable HTTP em `127.0.0.1`; instância nova por conexão HTTP (obrigatório para routing correto em spawns concorrentes); acessa PtyManager via Arc
4. **CanvasStore** (Zustand, React) — Nodes, edges, groups; alimentado por eventos Tauri (`node_created`, `node_exited`, `group_created`); nunca faz pull de estado Rust
5. **TerminalNode** (React + xterm.js) — Custom node do ReactFlow; Terminal em `useRef`; memoizado com `React.memo`; um Channel por pty_id; seletor Zustand por nó
6. **GroupFrame** (React) — Container visual ReactFlow com label do cwd e do grupo

**Padrões-chave:**
- Channel-per-PTY para bytes (não events broadcast)
- `spawn_blocking` para toda leitura de portable-pty
- `nodeTypes` declarado fora do componente ReactFlow (inline = recriação de todos os nós em cada render)
- `tokio::sync::RwLock` para HashMap de PtyEntries (nunca `std::sync::Mutex` atravessando `.await`)
- Instância nova do servidor MCP por conexão HTTP (não singleton global)

**Sequência de inicialização do grupo (ordem é crítica):**
1. Escrever `.mcp.json` no cwd do grupo apontando para o servidor MCP
2. Aguardar health-check HTTP do servidor MCP
3. Spawnar o Claude pai no cwd (lê `.mcp.json` no startup)

### Critical Pitfalls

Os pesquisadores identificaram 16 pitfalls. Os mais críticos para o roadmap:

1. **Wayland/NVIDIA blank window** (Pitfall 15) — Setar `WEBKIT_DISABLE_DMABUF_RENDERER=1` em `main()` antes do builder Tauri. Fase 0. Uma linha, mas trava tudo se esquecida.

2. **PTY read bloqueante** (Pitfall 1) — `portable-pty` é sync; SEMPRE `spawn_blocking` para leitura. Strava o runtime inteiro com 2+ terminais.

3. **spawn_agent timeout de 60 s** (Pitfalls 9/16) — O cliente MCP do Claude tem idle timeout de 60 s. `spawn_agent` pode bloquear por minutos. Fix obrigatório: emitir progress notification MCP a cada ~10 s. Claude v2.1.212+ auto-backgrounds MCP tool calls após ~2 min — verificar no spike.

4. **Recursão de filhos** (Pitfall 14) — Filhos herdam `.mcp.json` e podem chamar `spawn_agent`, gerando netos. Implementar depth guard no servidor (rejeitar depth > 1 por default) antes de qualquer teste real.

5. **WebGL context exhaustion** (Pitfall 6) — Limite de ~8–16 contextos WebGL por janela. Fix: `@xterm/addon-canvas` como renderer padrão; WebGL só para o nó focado.

6. **React Flow re-render cascade** (Pitfall 8) — `useNodes()` dentro de TerminalNode causa re-render de todos os nós em qualquer mudança. Fix: `React.memo` + seletor Zustand por nó + `nodeTypes` fora do render.

7. **fan-out PTY sem bloquear acumulador** (Pitfall 2) — Loop de leitura alimenta Channel (display) e `stdout_buf` (MCP). Usar `mpsc` bounded com `try_send` no Channel; nunca `send` bloqueante no loop.

---

## Implications for Roadmap

### Phase 0: Tauri Skeleton + Wayland Fix
**Rationale:** Resolver blank window NVIDIA/Wayland antes de qualquer outra linha de código.
**Delivers:** App Tauri rodando em Hyprland com janela visível; estrutura de pastas conforme ARCHITECTURE.md; Cargo.toml com todas as dependências declaradas
**Avoids:** Pitfall 15 (WEBKIT_DISABLE_DMABUF_RENDERER=1 em main() antes do builder)
**Verificação:** `cargo tauri dev` renderiza janela sem exports manuais de env no Hyprland

### Phase 1: PTY Foundation
**Rationale:** Tudo depende do PTY bridge ser sólido. Canvas, MCP e spawn_agent são inúteis sem leitura confiável. Lógica de spawn_blocking, fan-out, backpressure, UTF-8 e cleanup deve ser validada aqui com testes antes de qualquer UI.
**Delivers:** PtyManager completo em Rust; comandos Tauri `spawn_pty`, `write_pty`, `kill_pty`, `resize_pty`, `subscribe_pty_output` (Channel); kill_all em CloseRequested
**Addresses:**
- Pitfall 1 (spawn_blocking obrigatório para leitura sync)
- Pitfall 2 (backpressure: mpsc bounded + try_send no Channel)
- Pitfall 3 (UTF-8: emitir Vec<u8> via Channel; TextDecoder com stream:true no JS)
- Pitfall 13 (orphan processes: registry + kill_all em CloseRequested com timeout 3 s)
**Verificação:** Stress test `yes` pipe; teste UTF-8 com CJK split em chunk boundary; `ps aux` após fechar app = zero `claude`

### Phase 2: MCP Seam Spike (binário isolado)
**Rationale:** COSTURA MAIS ARRISCADA DO SISTEMA. Validar como binário isolado (sem Tauri, sem canvas) após a fundação PTY mas antes de qualquer trabalho de UI. O spike valida: rmcp rodando no mesmo tokio runtime, recebendo spawn_agent, spawning `claude -p "say hello"` via portable-pty, fan-out de leitura para display + acumulador, retorno do resultado no exit, progress notifications a cada 10 s, depth guard rejeitando chamadas de nível 2+.
**Delivers:** Binário standalone `turbo-mcp-spike` provando o loop completo
**Addresses:**
- Pitfall 9/16 (timeout: progress notifications a cada ~10 s enquanto filho roda)
- Pitfall 10 (transporte: Streamable HTTP only — nunca stdio, SSE deprecated)
- Pitfall 11 (concurrent routing: instância nova por conexão HTTP)
- Pitfall 14 (recursão: depth guard no servidor, rejeitar depth > 1)
- Pitfall 12 (shell injection: Command::new("claude").args(["-p", &task]) — nunca bash -c)
**Research flag:** Verificar comportamento de claude v2.1.212+ com auto-background de MCP tool calls após ~2 min durante o spike com a versão instalada no sistema
**Nota:** Descobrir problemas aqui custa horas; descobrir no Phase 5 custa dias de refactor

### Phase 3: Canvas + TerminalNode
**Rationale:** Com PTY validado, construir o canvas e conectar o primeiro terminal visível.
**Delivers:** ReactFlow canvas com pan/zoom; TerminalNode (xterm.js em nó custom); usePtyChannel hook; CanvasStore Zustand com nodes/edges; useCanvasEvents hook; spawn manual de um terminal
**Uses:** @xyflow/react 12.11.2; @xterm/addon-canvas (padrão) / addon-webgl (foco); addon-fit; Channel API Tauri
**Addresses:**
- Pitfall 5 (FitAddon resize loop: debounce + guard; NUNCA fit() em mudança de zoom — só em resize de layout)
- Pitfall 6 (WebGL limit: addon-canvas padrão; WebGL só no nó focado)
- Pitfall 7 (scrollback: 200 linhas para filhos, configurável para pai)
- Pitfall 8 (re-render cascade: React.memo + seletor por nó + nodeTypes fora do render)
- Pitfall 4 (SIGWINCH: ResizeObserver → fitAddon.fit() → invoke resize_pty → master.resize)
**Verificação:** 15 terminais simultâneos sem context loss; drag de um nó não flasha os outros (React Profiler)

### Phase 4: Group / CWD Abstraction
**Rationale:** Antes de integrar o MCP server completo, o conceito de grupo (frame + cwd + claude pai) deve estar funcional para que spawn_agent saiba a qual grupo pertence cada filho e qual cwd usar.
**Delivers:** GroupFrame node type; comando `create_group(cwd, label)`; escrita de `.mcp.json` no cwd → health-check MCP → spawn pai (ordem crítica); CanvasStore com slice de groups; múltiplos grupos coexistindo
**Addresses:** Anti-pattern de escrever .mcp.json depois de spawnar o Claude (causa: claude lê .mcp.json apenas no startup)

### Phase 5: MCP Server + spawn_agent Integrado
**Rationale:** Com spike validado e canvas + grupos funcionais, integrar o servidor MCP ao Tauri e ligar ao PtyManager via Arc.
**Delivers:** McpServer rmcp completo no runtime Tauri; spawn_agent com fan-out (Channel + acumulador); progress notifications a cada 10 s; depth guard; AppHandle::emit node_created → canvas atualiza; arestas pai→filho automáticas; label da tarefa no cabeçalho
**Addresses:**
- Pitfall 9/16 (timeout: progress notifications — resolver definitivamente aqui)
- Pitfall 14 (recursão: depth guard server-side, retorna erro se depth > 1)
- Pitfall 11 (concurrent: instância nova por conexão HTTP)
- Pitfall 12 (shell injection: validado no spike, aplicado aqui)
**Verificação:**
- 3 spawn_agent simultâneos retornam resultado correto para o chamador correto
- Task com `'; rm -rf /tmp/test'` não executa comando extra
- Child chamando spawn_agent é rejeitado com erro de depth
- Tarefa de 10 minutos completa sem timeout (progress notifications nos logs)

### Phase 6: Polish + Cleanup
**Rationale:** Finalizar para uso diário.
**Delivers:** Indicador de status nos nós (running/green, done/gray, error/red); botão Kill por nó (SIGTERM + fecha PTY + retorna erro ao MCP call em flight); kill_all no CloseRequested (timeout 3 s + force-kill); toolbar para criar grupos; labels de grupo com cwd
**Verificação:** Abre 5 terminais, fecha app, `ps aux | grep claude | grep -v grep` = zero resultados

### Phase 7: Persistence (v1.x — após validação diária)
**Rationale:** Adicionar só quando o app for usado diariamente e perder o layout virar dor real.
**Delivers:** Save/restore via ReactFlow.toObject() + ~/.config/turbo/canvas.json; posições e tamanhos de nós persistidos; grupos com cwds entre sessões
**Research flag:** Testar ReactFlow.toObject()/fromObject() com GroupFrame nodes e parentNode constraints — sub-flows podem ter gotchas com IDs de sessão que não sobrevivem ao relaunch

### Phase Ordering Rationale

- Phase 0 antes de tudo: blank window no Wayland/NVIDIA trava 100% do desenvolvimento
- Phase 1 (PTY) antes de Phase 3 (canvas): canvas sem PTY é demo; PTY não testado contamina tudo depois
- Phase 2 (spike MCP) entre Phase 1 e 3: costura mais arriscada deve ser validada cedo, como binário isolado, enquanto mudança de arquitetura é barata
- Phase 4 (grupos) antes de Phase 5 (MCP integrado): spawn_agent precisa do group_id e cwd para spawnar filho corretamente
- Phase 7 (persistência) por último: nenhum dado durável a persistir até o app ter sido usado o suficiente

### Research Flags

**Fases que precisam de pesquisa adicional durante planning:**
- **Phase 2 (MCP spike):** Verificar comportamento exato de claude v2.1.212+ com auto-background de MCP tool calls após ~2 min; testar com a versão instalada antes de decidir se progress notifications são suficientes ou se env var de timeout é necessária
- **Phase 5 (MCP integrado):** Confirmar API exata de instância-por-conexão do rmcp 0.8 em docs.rs antes de implementar; pode ter mudado entre versões
- **Phase 7 (persistência):** ReactFlow sub-flows + parentNode com save/restore — testar com grupos aninhados antes de assumir que toObject()/fromObject() funciona out-of-the-box

**Fases com padrões bem documentados (skip research-phase):**
- **Phase 0:** Env var documentada pelo Tauri; uma linha de código
- **Phase 1:** portable-pty + spawn_blocking + Channel API — padrão estabelecido, exemplos em tauri-terminal e OpenCove
- **Phase 3:** ReactFlow custom nodes + xterm.js em useRef + addon-fit — OpenCove é referência direta
- **Phase 4:** Grupos como parentNode do ReactFlow — documentado em react-flow sub-flows guide

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | MEDIUM | Tecnologias individuais bem documentadas; combinação Tauri+rmcp+portable-pty é nova o suficiente para requerer spike |
| Features | HIGH | Pesquisa cruzou com referências concretas (OpenCove, tauri-terminal, Claude Code Agent View); escopo bem delimitado |
| Architecture | MEDIUM | Patterns de PTY+Channel e MCP+Arc são sólidos; costura spawn_agent-bloqueante-em-tokio-Tauri é nova e requer spike |
| Pitfalls | HIGH | 16 pitfalls identificados com fontes nos issues oficiais; as críticas têm prevenção clara e verificável |

**Overall confidence:** MEDIUM — alta certeza sobre o que construir e como evitar problemas conhecidos; incerteza residual na costura MCP-em-Tauri justifica o spike como Phase 2 obrigatório.

### Gaps to Address

- **claude v2.1.212+ auto-background behavior:** A pesquisa cita que claude v2.1.212+ coloca MCP tool calls em background após ~2 min. Não está claro se isso interage com o spawn_agent bloqueante ou é ortogonal. Verificar durante o spike com a versão instalada.
- **rmcp instância-por-conexão API:** O padrão exato de como criar instância nova por conexão HTTP no rmcp 0.8 precisa ser confirmado em docs.rs — a API de closure factory pode ter mudado.
- **fan-out com try_send e drop de bytes:** Se o Channel estiver cheio e droparmos bytes do display, o retorno MCP ainda é correto (acumulador não é afetado). Decidir se isso é aceitável ou se backpressure mais agressivo é necessário.
- **`.mcp.json` type field:** ARCHITECTURE.md usa `"type": "sse"` (deprecated). Usar `"type": "http"` conforme spec atual e STACK.md — inconsistência nos docs de pesquisa deve ser resolvida na implementação.

---

## Sources

### Primary (HIGH confidence)
- [Tauri v2 official docs — Channel API, IPC, Linux graphics](https://v2.tauri.app)
- [Claude Code MCP official docs](https://code.claude.com/docs/en/mcp) — transporte, tipos, configuração
- [portable-pty docs.rs](https://docs.rs/portable-pty) — PtySize, resize, ChildKiller, sync nature
- [ReactFlow API reference + Performance docs](https://reactflow.dev) — nodeTypes, sub-flows, React.memo, useNodes anti-pattern
- [xterm.js GitHub issues #4379, #4841, #2662](https://github.com/xtermjs/xterm.js) — WebGL context limit, FitAddon bugs, resize loop

### Secondary (MEDIUM confidence)
- [rmcp docs.rs + GitHub](https://docs.rs/rmcp) — ServerHandler, StreamableHttpService, tool macros
- [OpenCove GitHub](https://github.com/DeadWaveWave/opencove) — referência de implementação xyflow + xterm.js + node-pty
- [tauri-terminal GitHub](https://github.com/marc2332/tauri-terminal) — referência PTY + Tauri Channel
- [Claude Code headless docs](https://code.claude.com/docs/en/headless) — `-p`, `--output-format`, `--max-turns`, `--dangerously-skip-permissions`
- [Zustand v5 slices pattern](https://zustand.docs.pmnd.rs) — seletores por nó, shallow equality

### Tertiary (LOW confidence)
- [Claude Code Issue #22542](https://github.com/anthropics/claude-code/issues/22542) — MCP idle timeout; workaround env var
- [Claude Code Issue #68110](https://github.com/anthropics/claude-code/issues/68110) — recursão exponencial de sub-agentes
- [Claude Code Issue #58687](https://github.com/anthropics/claude-code/issues/58687) — progress notifications e timeout behavior
- [Shuttle blog — streamable HTTP MCP in Rust](https://www.shuttle.dev/blog/2025/10/29/stream-http-mcp) — exemplo rmcp (community; verificar contra docs.rs)

---
*Research completed: 2026-08-04*
*Ready for roadmap: yes*
