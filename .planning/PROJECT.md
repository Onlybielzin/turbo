# Turbo — Canvas de Agentes

## What This Is

Turbo é um app de desktop pessoal com um canvas infinito estilo Figma onde cada nó é um terminal ao vivo rodando uma instância `claude`. Um Claude "pai" orquestra: ele dispara subagentes que, em vez de rodarem escondidos, aparecem como novos terminais visíveis no canvas, executando em tempo real. Vários grupos/projetos podem rodar ao mesmo tempo, lado a lado. É uma ferramenta de uso pessoal do vings (Arch/Omarchy/Hyprland).

## Core Value

Ver os subagentes do Claude trabalhando ao vivo — cada um no seu terminal visível no canvas — enquanto um Claude pai os orquestra e recebe os resultados de volta.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Canvas infinito estilo Figma com pan, zoom e arrastar de nós (funcional, sem exagero de polimento)
- [ ] Nó-terminal ao vivo: cada nó renderiza um `claude` rodando num pty, com saída em streaming e entrada de teclado
- [ ] Servidor MCP embutido no app expondo a tool `spawn_agent(tarefa, label)` que o Claude pai usa
- [ ] `spawn_agent` bloqueante: cria um terminal-filho no canvas, roda `claude -p`, e retorna o output final do filho pro pai
- [ ] Arestas pai→filho desenhadas no canvas (árvore de spawn visível)
- [ ] Múltiplos grupos/projetos simultâneos: cada grupo tem seu diretório de trabalho e seu Claude pai, coexistindo no mesmo canvas como "frames" separados
- [ ] Gerência de processos: matar/limpar ptys ao fechar o app (sem zumbis)

### Out of Scope

- Instalador bonito / empacotamento distribuível — ferramenta pessoal, roda local no dev
- Multiplataforma (Windows/macOS) — só Linux/Arch/Hyprland por enquanto
- Onboarding, docs de usuário final, autenticação — uso pessoal
- Janelas nativas do Hyprland como terminais — decidido usar canvas próprio embutido
- Modo "híbrido" (destacar agente em janela nativa) — pode virar v2 se precisar
- Fire-and-forget puro sem retorno pro pai — descartado em favor de retorno bloqueante

## Context

- Ambiente do dev: Arch (Omarchy), Wayland/Hyprland, 3 monitores. App roda local.
- Origem da ideia: hoje os subagentes do Claude Code rodam dentro do próprio processo, invisíveis; o vings quer "inverter" isso e ver cada subagente ao vivo, estilo cockpit visual.
- O Claude Code não expõe hook oficial para redirecionar subagentes internos a terminais externos, então o app é o próprio orquestrador: ele hospeda um MCP server e o Claude pai (rodando num terminal do canvas) chama a tool `spawn_agent` para criar filhos.
- Cada grupo mapeia para um projeto/diretório distinto; o Claude pai de cada grupo é lançado com aquele cwd.

## Constraints

- **Tech stack**: Tauri (core Rust) + React + xterm.js — decidido no brainstorm. PTYs via `portable-pty` no Rust, ponte para o front via comandos/eventos Tauri.
- **Canvas**: biblioteca de canvas infinito para React (ex.: react-flow/xyflow) com custom nodes = terminais — a validar no research.
- **MCP**: servidor MCP embutido no app (provável HTTP+SSE em localhost) para o Claude pai consumir a tool `spawn_agent`.
- **Plataforma**: Linux/Wayland (Hyprland) apenas.
- **Uso**: pessoal, single-user, local.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Canvas próprio embutido (não janelas nativas Hyprland) | Quer o "Figma de verdade" com zoom/pan/arestas e controle visual total | — Pending |
| Conteúdo dos nós = Claude pai + filhos (não shell genérico) | Foco em orquestrar vários Claude visualmente, fiel à ideia de subagentes | — Pending |
| `spawn_agent` bloqueante retorna output do filho | Semântica de subagente real: o pai coordena e sintetiza, mas cada filho fica visível | — Pending |
| Stack Tauri + React + xterm.js | Mais leve que Electron; vings topa o encanamento Rust do pty | — Pending |
| App hospeda o MCP server (sem observar arquivo) | Protocolo nativo de tools do Claude, mecanismo limpo para o pai criar filhos | — Pending |
| Múltiplos grupos/projetos no mesmo canvas | vings quer vários projetos rodando junto, cada um com seu cwd e seu pai | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-08-04 after initialization*
