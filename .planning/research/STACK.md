# Stack Research

**Domain:** Desktop app — infinite canvas of live AI agent terminals (Tauri + React)
**Researched:** 2026-08-04
**Confidence:** MEDIUM (cross-verified across official docs, crates.io, npm, and Claude Code official docs)

---

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

---

## Installation

```bash
# Scaffold the project
npm create tauri-app@latest turbo -- --template react-ts
cd turbo

# Canvas + terminal
npm install @xyflow/react @xterm/xterm @xterm/addon-webgl @xterm/addon-canvas @xterm/addon-fit

# State
npm install zustand immer

# Tauri JS bridge
npm install @tauri-apps/api

# Dev
npm install -D typescript vite @vitejs/plugin-react
```

```toml
# src-tauri/Cargo.toml dependencies
[dependencies]
tauri = { version = "2", features = ["unstable"] }
tauri-plugin-shell = "2"
portable-pty = "0.9"
rmcp = { version = "0.8", features = ["server", "macros", "transport-streamable-http-server"] }
axum = "0.8"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
schemars = { version = "1.0", features = ["derive"] }
anyhow = "1"
uuid = { version = "1", features = ["v4"] }
dashmap = "6"
```

---

## Concrete Integration Patterns

### 1. Tauri v2 Project Scaffolding

```bash
npm create tauri-app@latest turbo -- --template react-ts
```

This produces a Vite + React + TypeScript frontend with `src-tauri/` for the Rust core. Tauri v2.10.1 is current stable. No additional config for the webview is needed — Tauri bundles WebKit on Linux (which supports WebGL2 on Wayland/Hyprland).

### 2. PTY Bridge: Rust → Frontend via Channel API

The Channel API is the correct mechanism for streaming pty output. It is ordered and typed, unlike raw events.

**Rust (command that owns the pty session):**

```rust
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tauri::command]
async fn spawn_terminal(
    node_id: String,
    command: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
    on_data: Channel<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&command);
    for arg in &args { cmd.arg(arg); }
    cmd.cwd("/some/cwd");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    
    // Store writer handle for later input
    let writer = pair.master.take_writer().unwrap();
    state.ptys.insert(node_id.clone(), PtyHandle { writer, child });

    // Read loop — streams chunks to frontend
    let mut reader = pair.master.try_clone_reader().unwrap();
    let node_id_clone = node_id.clone();
    tokio::task::spawn_blocking(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = on_data.send(chunk);
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
async fn write_terminal(
    node_id: String,
    data: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if let Some(mut handle) = state.ptys.get_mut(&node_id) {
        handle.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(())
}
```

**TypeScript (React node component):**

```typescript
import { invoke, Channel } from '@tauri-apps/api/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';

// Inside the terminal node component
const term = new Terminal({ convertEol: true });
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
try {
  term.loadAddon(new WebglAddon());
} catch {
  // WebGL unavailable, falls back to DOM renderer
}
term.open(containerRef.current);
fitAddon.fit();

const channel = new Channel<string>();
channel.onmessage = (data) => term.write(data);

await invoke('spawn_terminal', {
  nodeId,
  command: 'claude',
  args: ['-p', task, '--output-format', 'stream-json'],
  cols: term.cols,
  rows: term.rows,
  onData: channel,
});

term.onData((data) => {
  invoke('write_terminal', { nodeId, data });
});
```

**Why Channel over emit:** `emit()` broadcasts to all windows and has serialization overhead per call. Channel is point-to-point, ordered, and batches better for high-frequency pty output.

### 3. Infinite Canvas: @xyflow/react

Use `@xyflow/react` v12 (current 12.11.2). It is the only React canvas library where custom nodes are first-class: a custom node is just a React component, so embedding an xterm.js div inside it is straightforward.

**Why not tldraw:** tldraw's canvas is shape-oriented; embedding live interactive DOM nodes (terminal) inside tldraw shapes is unsupported and requires hacks. @xyflow/react is built for interactive node-based UIs.

**Why not Konva/react-konva:** Canvas-based renderers cannot host live DOM elements inside nodes at all.

```typescript
import { ReactFlow, addEdge, useNodesState, useEdgesState } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { TerminalNode } from './TerminalNode';

const nodeTypes = { terminal: TerminalNode };

function Canvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={(params) => setEdges((eds) => addEdge(params, eds))}
    />
  );
}
```

**Performance concern with many terminals:** Each xterm.js Terminal with WebGL renderer creates a WebGL context. Browsers impose a limit of ~16–32 simultaneous WebGL contexts. For more than ~16 nodes, use the canvas (2D) addon or the default DOM renderer. Practical mitigation: use WebGL only for the active/focused terminal, canvas renderer for the rest.

### 4. xterm.js Packages

Use the `@xterm/*` scoped packages. The old `xterm` package is deprecated. Current: `@xterm/xterm` 6.0.0.

```
@xterm/xterm          # core — Terminal class
@xterm/addon-webgl    # WebGL2 renderer (preferred for active terminal)
@xterm/addon-canvas   # 2D canvas renderer (fallback / inactive terminals)
@xterm/addon-fit      # resize to container — required for node resize on pan/zoom
```

**No official React wrapper exists.** Wire the terminal imperatively via `useRef` and `useEffect` — create the Terminal instance on mount, call `term.open(ref.current)`, dispose on unmount. This is the standard pattern; React wrappers on npm are thin and unmaintained.

**Resize on xyflow node resize:** Listen to the node's ResizeObserver (or xyflow's `onResize` node callback), call `fitAddon.fit()`, then invoke a Tauri command to send `SIGWINCH` equivalent via `pair.master.resize(PtySize {...})`.

### 5. Embedded MCP Server (rmcp in Rust, streamable HTTP)

The MCP server runs inside the Tauri process, bound to `127.0.0.1` on a random or fixed port.

**Cargo.toml:**
```toml
rmcp = { version = "0.8", features = ["server", "macros", "transport-streamable-http-server"] }
axum = "0.8"
schemars = { version = "1.0", features = ["derive"] }
```

**Tool handler (Rust):**
```rust
use rmcp::{ServerHandler, tool, handler, model::*, transport::streamable_http_server::StreamableHttpService};
use schemars::JsonSchema;
use serde::Deserialize;

#[derive(Debug, Deserialize, JsonSchema)]
struct SpawnAgentParams {
    task: String,
    label: String,
}

#[derive(Clone)]
struct TurboMcpHandler {
    app_handle: tauri::AppHandle,
}

#[handler]
impl ServerHandler for TurboMcpHandler {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            name: "turbo".into(),
            version: "0.1.0".into(),
            ..Default::default()
        }
    }
}

impl TurboMcpHandler {
    #[tool(description = "Spawn a child Claude agent on the canvas and return its final output")]
    async fn spawn_agent(
        &self,
        rmcp::handler::Parameters(params): rmcp::handler::Parameters<SpawnAgentParams>,
    ) -> Result<CallToolResult, McpError> {
        // 1. Emit event to frontend: create new canvas node
        self.app_handle.emit("spawn-node", &params).unwrap();

        // 2. Run claude -p as subprocess, capture stdout
        let output = tokio::process::Command::new("claude")
            .arg("-p")
            .arg(&params.task)
            .arg("--output-format")
            .arg("text")
            .arg("--dangerously-skip-permissions")
            .current_dir("/path/to/cwd")
            .output()
            .await
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;

        let result = String::from_utf8_lossy(&output.stdout).to_string();
        Ok(CallToolResult::success(vec![Content::text(result)]))
    }
}

// Spawn MCP server in a background tokio task inside Tauri setup
pub fn start_mcp_server(app_handle: tauri::AppHandle, port: u16) {
    tokio::spawn(async move {
        let handler = TurboMcpHandler { app_handle };
        let service = StreamableHttpService::new(
            move || Ok(handler.clone()),
            Default::default(),
            Default::default(),
        );
        let router = axum::Router::new().nest_service("/mcp", service);
        let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}")).await.unwrap();
        axum::serve(listener, router).await.unwrap();
    });
}
```

**Important:** `spawn_agent` is blocking — it awaits `claude -p` completion before returning. This is the correct semantic: the MCP tool call is the synchronization point. The parent Claude blocks on it; when it returns, the parent gets the child's result. The child's pty terminal is visible on the canvas in real time via a separate xterm node that mirrors the subprocess output.

**Separating the visible pty from the blocking subprocess:** The `claude -p` for the child and the visible xterm for the child are the same process. Use the same approach: spawn via `portable-pty`, stream output to canvas node via Channel, AND collect all output into a `Vec<u8>` to return from the MCP tool when the process exits. The pty master reader is cloned: one clone feeds the Channel (live display), another clone accumulates the full output (for tool return value).

### 6. Connecting the Parent Claude to the MCP Server

When the parent Claude's terminal is launched, configure it to see the embedded MCP server:

**Option A: --mcp-config flag (preferred for programmatic launch)**

Write a temp JSON file, pass it to claude:

```typescript
// Rust side, when spawning the parent claude pty
const mcpConfigPath = `/tmp/turbo-mcp-${groupId}.json`;
const mcpConfig = {
  mcpServers: {
    turbo: {
      type: "http",
      url: `http://127.0.0.1:${mcpPort}/mcp`
    }
  }
};
fs::write(mcpConfigPath, serde_json::to_string(&mcpConfig)?)?;

let mut cmd = CommandBuilder::new("claude");
cmd.arg("--mcp-config");
cmd.arg(&mcpConfigPath);
cmd.cwd(&group.cwd);
// spawn into pty...
```

**Option B: User-scope persistent config**

```bash
claude mcp add --transport http --scope user turbo http://127.0.0.1:PORT/mcp
```

Writes to `~/.claude.json` under `mcpServers`. Persists across sessions. Simpler for personal use.

**Option C: Project .mcp.json**

In each project's working directory, place `.mcp.json`:
```json
{
  "mcpServers": {
    "turbo": {
      "type": "http",
      "url": "http://127.0.0.1:PORT/mcp"
    }
  }
}
```

Requires workspace trust approval on first run. For automated launch, Option A is cleanest.

**Note on type field:** `"type": "streamable-http"` is an accepted alias for `"type": "http"`. Use `"http"` for brevity.

### 7. Launching Claude Children Non-Interactively

The `spawn_agent` MCP handler calls claude as a subprocess:

```rust
// For blocking call that returns full output:
let output = tokio::process::Command::new("claude")
    .args(["-p", &task, "--output-format", "text", "--dangerously-skip-permissions"])
    .current_dir(&cwd)
    .output()  // awaits completion
    .await?;
let text_result = String::from_utf8_lossy(&output.stdout).to_string();

// For streaming to visible pty (spawn into PTY instead, collect via read loop):
// Use portable-pty spawn + read-all-then-return pattern
```

For the visible pty terminal on the canvas, spawn the child with `portable-pty` using `claude -p <task> --output-format stream-json`. The read loop both: (a) writes to the Channel → xterm display, and (b) accumulates NDJSON events. When the process exits, parse the last `result` event to get the final text, then return it from the MCP tool.

**Flags summary:**
- `-p` / `--print` — non-interactive mode (required)
- `--output-format stream-json` — NDJSON stream, shows thinking/tool use in real time
- `--output-format text` — simple final text only (use if you just need the result)
- `--dangerously-skip-permissions` — auto-approve all tool uses (needed for unattended children)
- `--allowedTools <list>` — restrict tool access for safety

---

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

---

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

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| `@xyflow/react` 12.11.2 | React 18 and 19 | No peer dep issues with React 19 |
| `@xterm/xterm` 6.0.0 | `@xterm/addon-webgl` 0.19.x, `@xterm/addon-canvas` 0.7.x, `@xterm/addon-fit` latest | All `@xterm/*` addons must match xterm major version |
| `tauri` 2.x | `@tauri-apps/api` 2.x | Major versions must match |
| `rmcp` 0.8 | `axum` 0.8, `tokio` 1, `schemars` 1.0 | rmcp pins axum; don't pull a different axum version |
| `portable-pty` 0.9 | `tokio` 1 (via `spawn_blocking`) | portable-pty is sync internally; wrap reads in `spawn_blocking` |
| `zustand` 5.0.8 | React 18+ | v5 drops some legacy React 17 compat |

---

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

---
*Stack research for: Turbo — infinite canvas of live Claude agent terminals*
*Researched: 2026-08-04*
