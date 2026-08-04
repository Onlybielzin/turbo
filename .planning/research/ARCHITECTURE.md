# Architecture Research

**Domain:** Personal Linux desktop app — infinite canvas of live claude agent terminals with visual orchestration
**Researched:** 2026-08-04
**Confidence:** MEDIUM (stack is well-documented; MCP-in-Tauri embedding is novel enough to warrant a spike)

---

## Standard Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  REACT FRONTEND (WebView)                                           │
│                                                                     │
│  ┌──────────────┐   ┌────────────────────────────────────────────┐  │
│  │  CanvasStore │   │  ReactFlow Canvas (@xyflow/react)          │  │
│  │  (Zustand)   │   │                                            │  │
│  │  - nodes[]   │◄──│  TerminalNode  GroupFrame  EdgeRenderer    │  │
│  │  - edges[]   │   │    (xterm.js)    (cwd label, border)       │  │
│  │  - groups[]  │   └────────────────────────────────────────────┘  │
│  └──────┬───────┘                                                   │
│         │  invoke / listen / Channel                                │
└─────────┼───────────────────────────────────────────────────────────┘
          │  Tauri IPC Bridge
┌─────────┼───────────────────────────────────────────────────────────┐
│  RUST BACKEND (Tauri core)                                          │
│                                                                     │
│  ┌──────▼───────────────────────────────────────────────────────┐   │
│  │  Tauri Command/Event Bridge                                  │   │
│  │  Commands: spawn_pty, write_pty, kill_pty, resize_pty        │   │
│  │  Channels: pty_output(pty_id, bytes)                         │   │
│  │  Events:   node_created, node_exited, group_created          │   │
│  └──────┬────────────────────────────────────┬──────────────────┘   │
│         │                                    │                      │
│  ┌──────▼───────────┐              ┌─────────▼──────────────────┐   │
│  │   PtyManager     │              │   McpServer (rmcp, SSE)    │   │
│  │   Arc<Mutex<..>> │              │   Tool: spawn_agent(task,  │   │
│  │                  │◄─────────────│     label, group_id)       │   │
│  │  id → PtyEntry   │  spawn_child │                            │   │
│  │  {pty, child,    │  + read loop │   binds to AppHandle       │   │
│  │   stdout_buf,    │  notify exit │   runs on tokio task       │   │
│  │   channel_tx}    │              └────────────────────────────┘   │
│  └──────────────────┘                                               │
└─────────────────────────────────────────────────────────────────────┘
          │ fork/exec + pty
┌─────────┼───────────────────────────────────────────────────────────┐
│  OS PROCESSES                                                        │
│  claude (parent, group A cwd)   claude -p (child, task X)           │
│  claude (parent, group B cwd)   claude -p (child, task Y)           │
└─────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Boundary |
|-----------|----------------|----------|
| PtyManager | Owns all OS pty/child-process state; spawn/read/write/kill; accumulates stdout for MCP return | Rust only — never accessed by frontend directly |
| Tauri Bridge | Translates between JS invoke() calls and Rust async commands; owns Channel streams per pty_id | The only legal crossing point between JS and Rust |
| McpServer | Embeds rmcp SSE server on localhost; handles spawn_agent tool calls; calls PtyManager | Rust only — talks to PtyManager via shared Arc |
| CanvasStore | Single Zustand store holding nodes, edges, groups; drives ReactFlow render | Frontend only — receives events from Tauri, never pulls |
| TerminalNode | ReactFlow custom node wrapping one xterm.js Terminal; bound to a pty_id | One instance per pty; subscribes to one Channel |
| GroupFrame | ReactFlow custom node rendered as a container/frame showing group cwd and label | Presentational; reads group slice from CanvasStore |
| ReactFlow Canvas | Pan/zoom/drag surface; renders all nodes and edges; fires onNodesChange/onEdgesChange | Layout and interaction only; does not own data |

---

## Recommended Project Structure

```
turbo/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs              # Tauri builder, app setup, MCP server startup
│   │   ├── pty/
│   │   │   ├── manager.rs       # PtyManager struct, spawn/read/write/kill/resize
│   │   │   └── types.rs         # PtyEntry, PtyId, PtyOutputPayload
│   │   ├── mcp/
│   │   │   ├── server.rs        # rmcp ServerHandler impl, SSE transport setup
│   │   │   └── tools.rs         # spawn_agent tool definition + handler
│   │   ├── commands.rs          # #[tauri::command] fns exposed to JS
│   │   └── state.rs             # AppState: Arc<PtyManager>, mcp_port
│   └── Cargo.toml
├── src/
│   ├── store/
│   │   ├── canvas.ts            # Zustand store: nodes, edges, groups slices
│   │   └── types.ts             # NodeData, EdgeData, Group, PtyNodeData
│   ├── components/
│   │   ├── Canvas.tsx           # ReactFlow wrapper, nodeTypes registration
│   │   ├── TerminalNode.tsx     # Custom node: xterm.js bound to pty_id Channel
│   │   ├── GroupFrame.tsx       # Custom node: frame/container for a group
│   │   └── Toolbar.tsx          # New group button, global controls
│   ├── hooks/
│   │   ├── usePtyChannel.ts     # Opens Tauri Channel for a pty_id, returns write fn
│   │   └── useCanvasEvents.ts   # Listens to node_created/node_exited Tauri events
│   ├── lib/
│   │   └── tauri.ts             # Typed wrappers around invoke() calls
│   └── main.tsx
└── package.json
```

---

## Architectural Patterns

### Pattern 1: Channel-per-PTY for Output Streaming

**What:** Each TerminalNode opens its own Tauri Channel bound to a pty_id at mount time. The Rust pty read-loop writes bytes into that channel. The React component writes bytes into xterm.js on each channel message.

**When to use:** Always — this is the only correct approach for high-throughput byte streams. Do not use Tauri global events for pty output; events are broadcast to all listeners and have no backpressure.

**Trade-offs:** A Channel requires the JS side to call an invoke() to establish it (passing a channel object as a parameter). The Rust command stores the channel sender in PtyEntry. The Channel stays open until the component unmounts or the pty exits.

**Rust side sketch:**
```rust
#[tauri::command]
async fn subscribe_pty_output(
    pty_id: String,
    channel: tauri::ipc::Channel<Vec<u8>>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.pty_manager.set_channel(pty_id, channel).await;
    Ok(())
}
```

**JS side sketch:**
```typescript
const channel = new Channel<Uint8Array>();
channel.onmessage = (bytes) => terminalRef.current?.write(bytes);
await invoke('subscribe_pty_output', { ptyId, channel });
```

### Pattern 2: Shared Arc AppState for MCP-to-PtyManager Communication

**What:** The MCP server and the Tauri commands share a single `Arc<AppState>` (containing `Arc<PtyManager>`). The MCP tool handler receives a clone of the Arc at server startup. No channels or message-passing between the MCP server and PtyManager — direct async method calls.

**When to use:** For the spawn_agent tool: the handler calls `pty_manager.spawn_child(task, group_id).await`, which creates the pty, starts the read loop, and returns a receiver for the child's captured stdout. The handler then `.await`s child exit, collects stdout, and returns `CallToolResult`.

**Trade-offs:** Arc<Mutex<>> or Arc<RwLock<>> around the HashMap of entries. Prefer `tokio::sync::RwLock` — reads (channel sends) are frequent and should not block each other. Write lock only for spawn/kill mutations.

**Concurrent spawn_agent calls from one parent:** Each call is a separate tokio task inside rmcp. They all call `pty_manager.spawn_child()` concurrently. Each gets its own PtyEntry with its own pty fd. No serialization needed.

### Pattern 3: Tauri Events for Canvas State Changes (not for pty bytes)

**What:** When a new child node is created (either by the user or by spawn_agent), the Rust backend emits a global `node_created` event via `AppHandle::emit()`. The React frontend's `useCanvasEvents` hook listens to this event and adds the node + edge to the Zustand store.

**When to use:** For discrete, infrequent events that drive canvas topology — node_created (with payload: {pty_id, parent_pty_id, group_id, label, position}), node_exited, group_created. Never for pty output bytes.

**JS side:**
```typescript
await listen<NodeCreatedPayload>('node_created', (event) => {
  canvasStore.addNode(event.payload);
  canvasStore.addEdge({ source: event.payload.parent_pty_id, target: event.payload.pty_id });
});
```

### Pattern 4: spawn_agent Blocking via tokio .await (not OS blocking)

**What:** The rmcp tool handler for spawn_agent does NOT block an OS thread. It awaits the child's exit using `child.wait().await` inside the async handler. Tokio's cooperative scheduling keeps all other pty read-loops and channel sends running while this await suspends.

**When to use:** This is the correct model. The parent claude's TCP connection to the MCP SSE server stays open (SSE is long-lived). The tool call response is sent over SSE when the handler future resolves — which happens when the child claude exits.

**Stdout capture:** The pty read-loop accumulates bytes into a `Vec<u8>` stored in PtyEntry. When the child exits, the handler drains the buffer and returns it as the tool result. Simultaneously, the read-loop forwards the same bytes to the Channel so the TerminalNode shows them live. This is a fan-out: one pty read writes to (a) the stdout accumulator in PtyEntry and (b) the Channel sender.

### Pattern 5: Group Abstraction as First-Class Zustand State

**What:** A Group is `{ id, label, cwd, parentPtyId, position: {x,y}, size: {w,h} }`. The CanvasStore maintains a `groups: Map<GroupId, Group>` slice. GroupFrame nodes render with the group's cwd as a label and serve as a visual container. PtyNodes belonging to a group carry a `groupId` field. ReactFlow's `parentNode` prop on a node constrains it inside a parent frame.

**When to use:** Creating a new group triggers: (1) Rust spawns the parent claude pty in that cwd with the pre-written .mcp.json, (2) emits `group_created` + `node_created` events, (3) React adds the GroupFrame node and the parent TerminalNode inside it.

---

## Data Flow

### Flow 1: User Creates a New Group

```
User clicks "New Group" (cwd: ~/projects/foo)
    ↓
invoke('create_group', { cwd, label })
    ↓
Rust: PtyManager.spawn_parent_claude(cwd)
  - writes .mcp.json to cwd with MCP server URL
  - spawns claude pty in cwd
  - starts pty read-loop task
  - returns { pty_id, group_id }
    ↓
Rust: AppHandle::emit('group_created', { group_id, pty_id, cwd, label })
Rust: AppHandle::emit('node_created', { pty_id, group_id, parent_pty_id: null, label })
    ↓
React: useCanvasEvents receives events
  → canvasStore.addGroup(...)
  → canvasStore.addNode(...)  ← GroupFrame + TerminalNode added
    ↓
TerminalNode mounts → usePtyChannel(pty_id) → invoke('subscribe_pty_output')
    ↓
Channel open; pty bytes flow: Rust read-loop → channel.send() → xterm.write()
```

### Flow 2: Parent Claude Calls spawn_agent

```
Parent claude (running in pty A) calls MCP tool spawn_agent({task, label})
    ↓
rmcp SSE server receives tool call on HTTP connection
    ↓
spawn_agent handler (tokio task):
  1. pty_manager.spawn_child(task, group_id).await
     - allocates new pty (pty B)
     - starts: claude -p "<task>" in group cwd
     - starts read-loop task: reads pty B, fan-out to:
         a) PtyEntry.stdout_buf (Vec<u8> accumulator)
         b) PtyEntry.channel_tx (if TerminalNode subscribed)
     - emits AppHandle event: node_created { pty_id_B, parent_pty_id_A, group_id, label }
  2. tokio .await child_B.wait()   ← suspends until claude -p exits
  3. drains PtyEntry.stdout_buf
  4. returns CallToolResult { content: stdout_text }
    ↓
React: node_created event received → addNode(pty_id_B) + addEdge(A→B)
    ↓
TerminalNode B mounts → subscribe_pty_output(pty_id_B)
    ↓
(While child runs) pty bytes stream live to TerminalNode B
    ↓
(Child exits) spawn_agent handler returns stdout to parent claude via SSE response
Parent claude receives tool result and continues orchestration
```

### Flow 3: User Keyboard Input to Terminal

```
User types in TerminalNode A (xterm.js onData callback)
    ↓
invoke('write_pty', { pty_id: A, data: bytes })
    ↓
Rust: PtyManager.write(A, bytes) → pty_A.write_all(bytes).await
    ↓
OS PTY → stdin of claude process A
```

### Flow 4: App Shutdown / PTY Cleanup

```
Tauri on_window_event(CloseRequested) or app exit hook
    ↓
PtyManager.kill_all()
  - for each PtyEntry: child.kill().await
  - drop all Pty handles (OS closes fds)
  - MCP server tokio task cancelled
    ↓
No zombie processes; OS reaps children
```

---

## Component Boundaries (what talks to what)

| From | To | Mechanism | Direction |
|------|----|-----------|-----------|
| TerminalNode | Rust PtyManager | Tauri Channel (subscribe) + invoke(write_pty) | bidirectional |
| McpServer | PtyManager | Direct Arc method call (same process, async) | MCP→Pty |
| McpServer | React | AppHandle::emit (Tauri event) | Rust→JS |
| React useCanvasEvents | Tauri | listen() on named events | Rust→JS |
| React Toolbar/UI | Rust commands | invoke() | JS→Rust |
| PtyManager | OS pty/child | pty-process crate (AsyncRead/AsyncWrite) | bidirectional |
| Parent claude | McpServer | HTTP+SSE on localhost (MCP protocol) | claude→server |
| McpServer | Parent claude | SSE response (tool call result) | server→claude |

Strict rule: **React never talks to OS processes. Rust never imports React. MCP server never talks to the frontend directly** — it only mutates PtyManager state and emits Tauri events through AppHandle.

---

## Group/Project Abstraction

Each group maps to one project directory and owns:
- One **parent TerminalNode** (the orchestrating claude instance)
- N **child TerminalNodes** (claude -p instances spawned via spawn_agent)
- One **GroupFrame** ReactFlow node (visual container / Figma frame)
- Shared `cwd` used for all pty spawns in the group
- A pre-written `.mcp.json` in the cwd pointing at the embedded MCP server

The `.mcp.json` approach is the cleanest way to configure a per-group parent claude:

```json
{
  "mcpServers": {
    "turbo": {
      "type": "sse",
      "url": "http://127.0.0.1:PORT/sse"
    }
  }
}
```

The Turbo app writes this file before spawning the parent claude, then launches `claude` (interactive mode) in that cwd. Claude picks up .mcp.json automatically.

Alternatively: pass `--mcp-server turbo=http://127.0.0.1:PORT/sse` on the command line (if the claude CLI supports that flag). The .mcp.json approach is more reliable and documented.

Child nodes are launched as `claude -p "<task>"` (non-interactive, print mode). They also run in the group cwd and inherit the .mcp.json — meaning a child could theoretically spawn grandchildren. The edge graph becomes a tree rooted at the parent.

ReactFlow models this as: GroupFrame node (type: 'group') as parent, with TerminalNodes having `parentNode: group_id` so ReactFlow constrains them inside the frame. Edges are source: parent_pty_id, target: child_pty_id.

---

## Build Order (Dependency Graph)

Build these in order — each layer depends on the one above being solid before wiring.

```
Layer 1: PTY Foundation (no UI, no MCP)
  └── PtyManager: spawn_pty, read loop with stdout accumulator, write, kill, resize
  └── Manual test: spawn a shell, write commands, read output, kill cleanly
  └── Risk: pty-process async read loop reliability; test here first

Layer 2: Tauri Bridge
  └── Commands: spawn_pty, write_pty, kill_pty, resize_pty, subscribe_pty_output (Channel)
  └── Events: node_created, node_exited emitted from Rust
  └── AppState wired into Tauri builder with PtyManager
  └── Manual test: invoke from browser console, see output in JS

Layer 3: React Canvas Shell
  └── ReactFlow canvas with pan/zoom
  └── TerminalNode (xterm.js + usePtyChannel hook)
  └── CanvasStore (Zustand): nodes/edges/groups slices
  └── useCanvasEvents hook wired to Tauri events
  └── Manual test: create a pty, subscribe, type, see output in xterm

Layer 4: Group Abstraction
  └── GroupFrame node type in ReactFlow
  └── create_group command: writes .mcp.json, spawns parent claude pty
  └── Groups slice in CanvasStore
  └── Manual test: create two groups with different cwds, verify isolation

Layer 5: MCP Server (THE RISKY SEAM — spike this early after Layer 1)
  └── rmcp SSE server embedded in Tauri tokio runtime
  └── spawn_agent tool: calls PtyManager, emits events, awaits exit, returns stdout
  └── Integration test: parent claude calls spawn_agent, child runs, result returned
  └── Concurrent spawn_agent test: parent spawns 3 children, all visible, all return

Layer 6: Polish
  └── Edge rendering (parent→child arrows in ReactFlow)
  └── App shutdown cleanup (kill_all)
  └── Toolbar, node labels, group labels
```

---

## Riskiest Integration Seam

**Layer 5: rmcp embedded inside Tauri's tokio runtime, with spawn_agent awaiting child exit while streaming bytes live**

This is the single most novel integration in the system — nothing in the library docs covers exactly this combination. The risks:

1. **Port conflict / MCP server startup race**: The MCP server must be listening before the parent claude is spawned. If the server starts asynchronously, the parent claude might connect before it is ready. Fix: await the server's bind confirmation before writing .mcp.json and spawning the parent.

2. **The fan-out read loop**: The pty read loop must simultaneously send bytes to (a) the stdout accumulator and (b) the Channel sender. If the Channel sender blocks (JS side is slow), it must not stall the accumulator write. Use a bounded tokio::sync::mpsc channel for the frontend stream; if it's full, drop/backpressure instead of blocking the loop.

3. **SSE connection lifetime vs tool call duration**: A claude -p child might run for minutes. The parent claude's SSE connection to the MCP server must stay open for the entire duration. rmcp handles this natively (SSE is long-lived by design), but verify the Tauri webview or OS does not time out idle TCP connections on localhost.

4. **Tokio runtime sharing**: Tauri uses its own tokio runtime. Running the rmcp HTTP+SSE server on the same runtime is possible (spawn as a tokio task via `tauri::async_runtime::spawn`), but ensure the server's Axum listener does not compete with Tauri's own async work. A separate tokio::Runtime for the MCP server is an escape hatch if contention is observed.

5. **claude -p stdout not flushed**: claude may buffer stdout when not connected to a terminal. Running it under a pty forces line-buffering/no-buffering, which is exactly why using a pty for the child (not just tokio::process::Command) matters for live streaming.

**Spike strategy**: Before building Layer 3-4, build a minimal binary (outside Tauri) that: spawns an rmcp SSE server, receives a spawn_agent call, spawns a `claude -p "say hello"` under a pty, streams its output, and returns the result. This validates the core loop in isolation.

---

## Anti-Patterns

### Anti-Pattern 1: Using Tauri Events for PTY Byte Streaming

**What people do:** `app_handle.emit("pty_output", (pty_id, bytes))` in the read loop.

**Why it's wrong:** Events are broadcast to all listeners, not per-consumer. If two TerminalNodes listen for `pty_output`, both receive all bytes. There is no ordering guarantee under high throughput. Events add JSON serialization overhead on every byte chunk.

**Do this instead:** Use `tauri::ipc::Channel<Vec<u8>>` per pty_id. Each TerminalNode subscribes its own channel at mount. Only that channel receives that pty's output.

### Anti-Pattern 2: Blocking the tokio Runtime in spawn_agent

**What people do:** `std::thread::sleep` or `std::process::Command::wait` (blocking) inside the async spawn_agent handler.

**Why it's wrong:** Blocks the tokio thread that services the MCP connection, stalling all other MCP requests and async work on that thread.

**Do this instead:** `child.wait().await` — tokio suspends the task cooperatively, freeing the thread for other work. Only use `spawn_blocking` for truly synchronous CPU-bound work.

### Anti-Pattern 3: Sharing Mutable PtyEntry Across Tasks Without Proper Sync

**What people do:** Store pty handles in a plain HashMap inside a Mutex, then hold the lock across an await point.

**Why it's wrong:** Holding a `std::sync::Mutex` across an `.await` can deadlock or panic depending on the executor.

**Do this instead:** Use `tokio::sync::RwLock` for the HashMap. Acquire the lock, clone the relevant data or channel sender, release the lock, then do async I/O. Never hold the lock while awaiting.

### Anti-Pattern 4: Writing .mcp.json after Spawning the Parent Claude

**What people do:** Spawn the parent claude first, then write .mcp.json.

**Why it's wrong:** Claude reads .mcp.json at startup. If the file is written after claude starts, the parent claude does not connect to the MCP server.

**Do this instead:** Write .mcp.json → wait for MCP server to be listening → spawn parent claude. Verify with a health check (HTTP GET on the MCP server URL) before spawning.

---

## Integration Points

### Internal Boundaries

| Boundary | Communication | Constraint |
|----------|---------------|------------|
| McpServer ↔ PtyManager | Direct Arc method calls (same process) | No cross-boundary serialization |
| Tauri Bridge ↔ PtyManager | Tauri State extractor in command fns | PtyManager must be Send+Sync |
| React ↔ Rust (pty bytes) | tauri::ipc::Channel per pty_id | One Channel per live TerminalNode |
| React ↔ Rust (canvas events) | tauri event listen() | Named events with typed JSON payloads |
| React ↔ Rust (user commands) | invoke() typed wrappers | Validated at Tauri command boundary |
| Parent claude ↔ McpServer | HTTP+SSE localhost | MCP protocol; long-lived connection |

### External Processes

| Process | Launch Mechanism | Config |
|---------|-----------------|--------|
| Parent claude (interactive) | pty_process::Command in group cwd | .mcp.json pre-written in cwd |
| Child claude (non-interactive) | pty_process::Command with -p flag | inherits .mcp.json from group cwd |

---

## Sources

- [Tauri v2 IPC — Calling Rust from Frontend](https://v2.tauri.app/develop/calling-rust/)
- [Tauri v2 Inter-Process Communication Concepts](https://v2.tauri.app/concept/inter-process-communication/)
- [rmcp crate — Official MCP Rust SDK](https://crates.io/crates/rmcp)
- [Building MCP Servers in Rust with rmcp](https://rup12.net/posts/write-your-mcps-in-rust/)
- [pty-process crate docs](https://docs.rs/pty-process/latest/pty_process/)
- [ReactFlow API Reference](https://reactflow.dev/api-reference/react-flow)
- [Zustand Slices Pattern](https://zustand.docs.pmnd.rs/learn/guides/slices-pattern)
- [Claude CLI MCP Configuration Guide](https://glama.ai/mcp/servers/@redaphid/mcp-memory/blob/5aac4bcb1a4f2cdb47618efb0a8418e41b111e9b/MCP_CONFIGURATION_GUIDE.md)
- [rmcp GitHub — Official Rust SDK](https://github.com/modelcontextprotocol/rust-sdk)

---
*Architecture research for: Turbo — Canvas de Agentes*
*Researched: 2026-08-04*
