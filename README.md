# Turbo — Canvas de Agentes

Cockpit visual pessoal: um canvas infinito estilo Figma onde cada nó é um terminal
ao vivo rodando `claude`, e um Claude "pai" orquestra filhos visíveis via uma tool
MCP `spawn_agent`. Ferramenta pessoal (Linux/Wayland/Hyprland).

Ver `.planning/` para visão completa, requisitos, pesquisa e roadmap.

## Stack

- **Tauri v2** (core Rust) + **React + TypeScript** (Vite)
- **PTY**: `portable-pty` no Rust, streaming de bytes para o webview via Tauri `Channel`
- **Terminal**: `@xterm/xterm` (renderer canvas)
- (fases futuras) `@xyflow/react` para o canvas, `rmcp` para o servidor MCP embutido

## Rodar (dev)

```bash
cd app
npm install          # primeira vez
npm run tauri dev    # compila o Rust, sobe o Vite e abre a janela
```

O fix de janela preta no Wayland/Hyprland (`WEBKIT_DISABLE_DMABUF_RENDERER=1`) já é
aplicado em `src-tauri/src/main.rs` — não precisa exportar nada à mão.

## Build

```bash
cd app
npm run tauri build  # binário de release
```

## Estado por fase

| Fase | Descrição | Status |
|------|-----------|--------|
| 1 | Fundação: janela Tauri + bridge PTY (spawn/read/write/resize/kill, sem órfãos) | ✅ Implementada — compila (cargo + vite verdes) |
| 2 | Spike MCP isolado: `spawn_agent` bloqueante + progress notifications + depth guard | ⏳ Pendente |
| 3 | Canvas + TerminalNodes + Grupos (xyflow + xterm, GroupFrames com cwd) | ⏳ Pendente |
| 4 | Orquestração MCP integrada no Tauri (pai cria filhos no canvas) | ⏳ Pendente |

O que a Phase 1 entrega hoje: o app abre com um terminal real (shell) ao vivo —
digitar funciona, redimensionar ajusta o PTY, e fechar o app mata os processos filhos.

## Layout

```
app/                 # app Tauri + React
  src/               # front (App, components/Terminal)
  src-tauri/         # backend Rust (PTY manager em src/lib.rs)
assets/logo.svg      # logo (fonte do ícone; gerar com `tauri icon assets/logo.svg`)
.planning/           # docs GSD: PROJECT, REQUIREMENTS, ROADMAP, research, phases/
```
