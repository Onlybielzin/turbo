<!-- GSD:project-start source:PROJECT.md -->

## Project

**Turbo — Canvas de Agentes**

Turbo é um app de desktop pessoal com um canvas infinito estilo Figma onde cada nó é um terminal ao vivo rodando uma instância `claude`. Um Claude "pai" orquestra: ele dispara subagentes que, em vez de rodarem escondidos, aparecem como novos terminais visíveis no canvas, executando em tempo real. Vários grupos/projetos podem rodar ao mesmo tempo, lado a lado. É uma ferramenta de uso pessoal do vings (Arch/Omarchy/Hyprland).

**Core Value:** Ver os subagentes do Claude trabalhando ao vivo — cada um no seu terminal visível no canvas — enquanto um Claude pai os orquestra e recebe os resultados de volta.

### Constraints

- **Tech stack**: Tauri (core Rust) + React + xterm.js — decidido no brainstorm. PTYs via `portable-pty` no Rust, ponte para o front via comandos/eventos Tauri.
- **Canvas**: biblioteca de canvas infinito para React (ex.: react-flow/xyflow) com custom nodes = terminais — a validar no research.
- **MCP**: servidor MCP embutido no app (provável HTTP+SSE em localhost) para o Claude pai consumir a tool `spawn_agent`.
- **Plataforma**: Linux/Wayland (Hyprland) apenas.
- **Uso**: pessoal, single-user, local.

<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->

## Technology Stack

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Tauri | 2.10.1 (stable) | Rust desktop shell, IPC, PTY management, MCP server host | Much lighter than Electron; Rust gives direct PTY and process control without Node shims; v2 is the current stable branch |
| React | 19.x | UI framework for canvas + terminal nodes | Standard choice; @xyflow/react v12 is React-first; no need for Vue/Svelte given team familiarity |
| TypeScript | 5.x | Type safety across IPC boundaries | IPC contracts between Rust and frontend must be typed to avoid runtime surprises |
| Vite | 6.x | Frontend bundler (bundled with create-tauri-app) | Default in create-tauri-app React template; fast HMR critical for dev velocity |
| @xyflow/react | 12.11.2 | Infinite pan/zoom canvas with custom nodes and edges | Only mature React canvas library that supports fully custom interactive nodes natively |
| @xterm/xterm | 6.0.0 | Terminal emulator rendered inside each canvas node | Industry standard; WebGL renderer handles many simultaneous instances efficiently |
| Zustand | 5.0.8 | Frontend state: nodes, groups, process map, edges | Minimal boilerplate; slice pattern maps cleanly to per-node pty state |
| portable-pty | 0.9.x (Rust) | PTY allocation and bidirectional I/O in Rust backend | Used by WezTerm in production; cross-platform API; tauri-plugin-pty wraps it |
| rmcp | 0.8.x / 3.1.0 | Embedded MCP server in Rust (streamable HTTP) | Official Rust SDK for MCP; ships StreamableHttpService built on axum; tool macros |
| axum | 0.8 | HTTP server for MCP endpoint (used by rmcp internally) | rmcp's HTTP transport is axum-based; consistent tokio runtime |
| tokio | 1.x | Async runtime for PTY read loops, MCP server, subprocess | Already required by Tauri internals; single runtime for everything |

### Supporting Libraries (npm)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @xterm/addon-webgl | 0.19.x | GPU-accelerated terminal renderer | Default renderer for all nodes; falls back to canvas addon on WebGL failure |
| @xterm/addon-canvas | 0.7.x | 2D canvas renderer (WebGL fallback) | Only as fallback when WebGL2 unavailable |
| @xterm/addon-fit | latest | Resize terminal to container dimensions | Required — each node resizes on zoom/drag |
| @tauri-apps/api | 2.x | IPC primitives: invoke, Channel, listen | Core bridge between React and Rust |
| @tauri-apps/plugin-shell | 2.x | Shell command utilities (optional) | Only if you need shell escaping utils; PTY handled in Rust directly |
| immer | 10.x | Immutable Zustand state updates | Simplifies deeply nested node state mutations (follow immutability rule) |

### Supporting Crates (Rust)

| Crate | Version | Purpose | When to Use |
|-------|---------|---------|-------------|
| portable-pty | 0.9 | Allocate PTY, spawn process, get reader/writer | Core of every terminal node's backend |
| tokio | 1 | Async runtime — PTY read loop + MCP server | Already a Tauri dependency |
| serde / serde_json | 1 | Serialize IPC payloads and MCP tool params | Required for Channel typed payloads and rmcp tool parameters |
| schemars | 1.0 | JSON schema generation for MCP tool parameters | Required by rmcp macros to describe tool input schemas |
| anyhow | 1 | Error handling in commands and MCP handlers | Ergonomic error propagation |
| uuid | 1 | Node IDs, session IDs | Each pty/node needs a stable unique key |
| dashmap | 6 | Concurrent HashMap: node_id → pty handle | Safe concurrent access from multiple async tasks |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| create-tauri-app | Project scaffolding | `npm create tauri-app@latest -- --template react-ts` |
| cargo-watch | Auto-rebuild Rust on change | `cargo watch -x build` during development |
| Rust nightly (optional) | Not required | Stable Rust 1.80+ works with all listed crates |

## Installation

# Scaffold the project

# Canvas + terminal

# State

# Tauri JS bridge

# Dev

# src-tauri/Cargo.toml dependencies

## Concrete Integration Patterns

### 1. Tauri v2 Project Scaffolding

### 2. PTY Bridge: Rust → Frontend via Channel API

#[tauri::command]
#[tauri::command]

### 3. Infinite Canvas: @xyflow/react

### 4. xterm.js Packages

### 5. Embedded MCP Server (rmcp in Rust, streamable HTTP)

#[derive(Debug, Deserialize, JsonSchema)]
#[derive(Clone)]
#[handler]

### 6. Connecting the Parent Claude to the MCP Server

### 7. Launching Claude Children Non-Interactively

- `-p` / `--print` — non-interactive mode (required)
- `--output-format stream-json` — NDJSON stream, shows thinking/tool use in real time
- `--output-format text` — simple final text only (use if you just need the result)
- `--dangerously-skip-permissions` — auto-approve all tool uses (needed for unattended children)
- `--allowedTools <list>` — restrict tool access for safety

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Desktop shell | Tauri v2 | Electron | Electron: 50–100 MB overhead, Node.js PTY is less reliable, heavier memory per window |
| Canvas library | @xyflow/react | tldraw | tldraw: shape-canvas, not node-graph; can't host live interactive DOM nodes inside shapes |
| Canvas library | @xyflow/react | react-konva | react-konva: pure Canvas 2D, no DOM nodes inside shapes possible |
| Canvas library | @xyflow/react | Excalidraw | Excalidraw: whiteboard tool, not a programmable node graph |
| Terminal renderer | @xterm/xterm | xterm (old) | xterm is deprecated; use @xterm/xterm |
| MCP server | rmcp (Rust) | Node.js sidecar MCP server | Sidecar adds process management complexity, IPC overhead, and language boundary; rmcp runs in the same Tauri process/tokio runtime |
| MCP server | rmcp (Rust) | rust-mcp-sdk | rust-mcp-sdk is less mature; rmcp is the reference Rust MCP SDK with official spec compliance |
| PTY | portable-pty (direct) | tauri-plugin-pty | tauri-plugin-pty (0.1.1, 22 stars) is too early-stage for production; wraps portable-pty anyway; doing it directly gives exit detection and full control |
| State | Zustand | Redux Toolkit | Redux: excessive boilerplate for a personal tool with many independent node states |
| State | Zustand | Jotai | Jotai is atom-per-value model; Zustand slices map better to per-group/per-node bounded stores |
| MCP transport | Streamable HTTP | stdio | stdio MCP requires the parent claude to launch the MCP server as a child; embedded HTTP lets claude connect to an already-running server without process coupling |
| MCP transport | Streamable HTTP | SSE (deprecated) | Claude Code docs explicitly say SSE is deprecated; use HTTP |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `xterm` (unscoped npm package) | Deprecated as of v5.4.0, no longer maintained | `@xterm/xterm` |
| `xterm-addon-webgl`, `xterm-addon-fit` (unscoped) | Deprecated alongside `xterm` | `@xterm/addon-webgl`, `@xterm/addon-fit` |
| `react-flow` (old package name) | Renamed to `@xyflow/react` at v12; old package stuck at v11 | `@xyflow/react` |
| `pty-process` Rust crate | Tokio-only, less battle-tested than portable-pty; no Windows (not needed here, but indicates maturity gap) | `portable-pty` |
| WebSocket MCP transport | Claude Code docs note WS doesn't support OAuth and `--transport` flag; adds bidirectional complexity you don't need | HTTP transport (`type: "http"`) |
| `tauri-plugin-pty` | 0.1.1, semi-documented, 22 stars, no exit detection in documented API, wraps portable-pty anyway | `portable-pty` directly with Channel API |
| Multiple simultaneous WebGL contexts (>16) | Browser/WebKit limit ~16–32 WebGL contexts; exceeding causes context loss | Use WebGL for active node, `@xterm/addon-canvas` for inactive nodes |
| `claude` without `-p` flag | Interactive TUI mode — blocks, no stdout capture possible | `claude -p` for non-interactive child agents |
| `.mcp.json` type field as `sse` | SSE transport deprecated in Claude Code | `"type": "http"` |

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| `@xyflow/react` 12.11.2 | React 18 and 19 | No peer dep issues with React 19 |
| `@xterm/xterm` 6.0.0 | `@xterm/addon-webgl` 0.19.x, `@xterm/addon-canvas` 0.7.x, `@xterm/addon-fit` latest | All `@xterm/*` addons must match xterm major version |
| `tauri` 2.x | `@tauri-apps/api` 2.x | Major versions must match |
| `rmcp` 0.8 | `axum` 0.8, `tokio` 1, `schemars` 1.0 | rmcp pins axum; don't pull a different axum version |
| `portable-pty` 0.9 | `tokio` 1 (via `spawn_blocking`) | portable-pty is sync internally; wrap reads in `spawn_blocking` |
| `zustand` 5.0.8 | React 18+ | v5 drops some legacy React 17 compat |

## Sources

- [Tauri v2 official docs — Channel API](https://v2.tauri.app/develop/calling-rust/) — MEDIUM confidence (official docs, verified)
- [Tauri JS API reference — Channel class](https://tauri.app/reference/javascript/api/namespacecore/) — MEDIUM confidence (official)
- [rmcp docs.rs 3.1.0](https://docs.rs/rmcp/latest/rmcp/) — LOW confidence (fetched, current)
- [Shuttle blog — streamable HTTP MCP in Rust](https://www.shuttle.dev/blog/2025/10/29/stream-http-mcp) — LOW confidence (community)
- [Claude Code non-interactive mode docs](https://jackdog668-claude-code.mintlify.app/usage/non-interactive-mode) — LOW confidence (community mirror)
- [Claude Code MCP official docs](https://code.claude.com/docs/en/mcp) — MEDIUM confidence (official)
- [@xyflow/react npm](https://www.npmjs.com/package/@xyflow/react) — current version 12.11.2 verified
- [xtermjs/xterm.js releases](https://github.com/xtermjs/xterm.js/releases) — @xterm/xterm 6.0.0 (Dec 2024) verified
- [tauri-plugin-pty GitHub](https://github.com/Tnze/tauri-plugin-pty) — LOW confidence (early stage project)
- [zustand v5 announcement](https://pmnd.rs/blog/announcing-zustand-v5/) — v5.0.8 current as of Aug 2025

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
