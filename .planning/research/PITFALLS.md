# Pitfalls Research

**Domain:** Infinite canvas desktop app — PTY terminals + xterm.js + react-flow + embedded MCP + claude child processes (Tauri v2 / Rust / Wayland)
**Researched:** 2026-08-04
**Confidence:** HIGH (domain-specific issues cross-verified across official docs, GitHub issues, and MCP spec)

---

## Critical Pitfalls

### Pitfall 1: Blocking PTY Read Starving the Async Runtime

**What goes wrong:**
`portable-pty`'s `try_clone_reader()` returns a synchronous `Read` implementation. If you call `.read()` directly on a Tokio task without spawning it on `spawn_blocking`, you block the async thread and starve every other future on that executor. With several live terminals, a single slow reader locks out IPC, the MCP server, and process-management tasks.

**Why it happens:**
It's natural to `await` an `AsyncRead` wrapper around the PTY reader. Developers assume the crate is async-native because the rest of Tauri is async. The crate is _not_ async — it is a sync wrapper around OS primitives.

**How to avoid:**
Spawn each PTY reader in a `tokio::task::spawn_blocking` thread and forward data into an `mpsc::channel` that the async side selects on. Alternatively use the `pty-process` crate, which wraps the master fd into a tokio `AsyncRead`. Never call `.read()` in-line inside an async function on the blocking reader.

**Warning signs:**
- App becomes unresponsive after more than 2–3 terminals are opened
- Tauri IPC commands stop responding while a terminal is writing lots of output
- `tokio::time::sleep` futures in the same runtime appear to stall

**Phase to address:** PTY foundation phase (Phase 1 / first milestone)

---

### Pitfall 2: PTY Backpressure — Child Floods Stdout and Fills the Tauri Channel

**What goes wrong:**
A `claude` child that emits dense output (e.g., long code generation) produces data faster than the frontend renders it. The Tauri `Channel` or `mpsc` buffer fills. If the sender blocks, the PTY read loop stalls; if it drops data, xterm output is corrupted. Either way the parent MCP call never unblocks.

**Why it happens:**
Tauri's channel is designed for UI events, not high-throughput byte streams. Default buffer sizes are small. Developers use `channel.send()` inside a tight read loop without back-pressure signalling.

**How to avoid:**
Use a bounded `mpsc` channel (e.g., 64 KB worth of chunks) between the PTY reader thread and the Tauri emit loop. On the Tauri emit side, use `try_send` and drop or throttle rather than block. On the front-end, buffer incoming chunks in a Ref outside React state and drain them with `requestAnimationFrame` before writing to `xterm.write()`. Never pass raw PTY bytes directly to React state on every chunk.

**Warning signs:**
- Frontend lags increasingly behind during large outputs
- `spawn_agent` calls that complete in `claude -p` but never return to the parent
- xterm cursor position drifts (mid-stream data dropped)

**Phase to address:** PTY foundation phase; validate with a synthetic `yes` command stress test before integrating MCP

---

### Pitfall 3: ANSI / UTF-8 Chunk Boundary Corruption in xterm

**What goes wrong:**
A multi-byte UTF-8 character (e.g., a CJK character = 3 bytes, an emoji = 4 bytes) or a multi-byte ANSI escape sequence is split across two PTY read buffers. When each chunk is individually converted to a JS string with `TextDecoder` or via Tauri's JSON serialisation, the incomplete byte sequence is replaced with `U+FFFD` (replacement character) or silently dropped. xterm then renders garbage characters, messes up cursor positioning, or displays wrong colours mid-line.

**Why it happens:**
The common shortcut is to convert each read chunk to a UTF-8 string immediately on the Rust side (`String::from_utf8_lossy(&buf)`) before emitting. This is lossy by design and destroys split multi-byte sequences. Tauri's JSON serialisation of `Vec<u8>` adds another conversion risk.

**How to avoid:**
- Emit raw bytes as a `Vec<u8>` (Tauri `tauri::ipc::Channel` supports binary frames), or as a base64-encoded string, to the frontend.
- On the JS side use a single persistent `TextDecoder` instance per terminal created with `new TextDecoder('utf-8', { fatal: false, ignoreBOM: false })` and call `decoder.decode(chunk, { stream: true })`. The `stream: true` option holds partial bytes across calls.
- For ANSI sequences, xterm.js's internal parser already handles split escape sequences correctly — feed raw bytes without pre-parsing.

**Warning signs:**
- Random `?` or `<EF BF BD>` in terminal output
- Colour codes appearing split across lines
- Terminal output from `claude` (which outputs heavy Unicode and ANSI) looks corrupted while a plain `echo` command looks fine

**Phase to address:** PTY foundation phase; write a dedicated test that pipes CJK + emoji through the PTY bridge before any UI work

---

### Pitfall 4: SIGWINCH Not Sent After Canvas Node Resize

**What goes wrong:**
The user resizes a terminal node on the canvas (drag handle). The xterm `FitAddon` recalculates cols/rows and calls `terminal.resize(cols, rows)`. But the PTY is never told about the new size — `MasterPty::resize(PtySize { rows, cols, .. })` is never called via Tauri IPC. The child `claude` process still believes the terminal is 80×24. Line wrapping breaks, `vi`-style TUIs go wrong, and `claude`'s output width causes misaligned output.

**Why it happens:**
Resize is a two-step protocol that crosses the Tauri IPC bridge: (1) frontend → Rust `resize_pty(id, cols, rows)` Tauri command; (2) Rust calls `master.resize(PtySize)` which sends SIGWINCH to the child. Step 2 is frequently forgotten or wired up after the visible UI works.

**How to avoid:**
Make `ResizeObserver` on each terminal node's DOM container the single source of truth. When the container dimensions change: call `fitAddon.fit()` → read `terminal.cols`/`terminal.rows` → invoke Tauri `resize_pty` command → Rust calls `master.resize`. Add an assertion test: spawn `stty size` in a PTY and verify the output matches the terminal's cols/rows after a resize.

**Warning signs:**
- Claude output wraps mid-sentence at a fixed column (80 or 120) regardless of terminal width
- Interactive TUI tools (less, vi) look wrong after resizing
- `echo $COLUMNS` inside the terminal returns the initial value

**Phase to address:** PTY + xterm integration phase; must be solved before MCP integration

---

### Pitfall 5: xterm.js FitAddon Resize Loop Inside a CSS-Transformed Canvas Node

**What goes wrong:**
React Flow renders nodes inside `<foreignObject>` elements that are subject to the canvas's CSS `transform: matrix(...)` (pan + zoom). `FitAddon.proposeDimensions()` reads `offsetWidth`/`offsetHeight` from the terminal container DOM element — but these values reflect the _CSS-transformed_ size, not the logical layout size. At zoom != 1.0, FitAddon computes the wrong cols/rows. Furthermore, when FitAddon calls `terminal.resize()`, xterm recalculates its internal canvas size, which may change the DOM element's size, which triggers `ResizeObserver`, which calls `fit()` again — an infinite resize loop.

**Why it happens:**
`getBoundingClientRect()` returns values scaled by CSS transforms, while `offsetWidth` returns the pre-transform layout size. FitAddon uses `offsetWidth`, which actually avoids the zoom scaling problem for the cols/rows calculation, but still causes the loop when the container height is percentage-based and the calculated rows change the container.

**How to avoid:**
- Set a fixed pixel height on the xterm container div (not percentage-based) to break the loop.
- Debounce the `ResizeObserver` callback (16–32 ms) to prevent rapid consecutive `fit()` calls.
- After `fitAddon.fit()`, guard with a check: if `newCols === terminal.cols && newRows === terminal.rows`, skip the resize.
- When the canvas zoom changes, do _not_ call `fit()` — zoom changes the visual scale, not the logical terminal size. Only resize the PTY when the node's layout (handle drag) changes.

**Warning signs:**
- Terminal flickers or jumps during canvas zoom in/out
- Browser console shows `ResizeObserver loop limit exceeded`
- PTY resize IPC calls fire hundreds of times per second

**Phase to address:** Canvas + xterm integration phase (second major milestone)

---

### Pitfall 6: WebGL Context Exhaustion — Too Many xterm Terminals

**What goes wrong:**
Browsers (including the Chromium webview inside Tauri) enforce a hard limit on simultaneous WebGL contexts. The number varies but is typically 8–16 per page. If you create one `WebglAddon` per terminal node, you hit this limit with as few as 10 visible terminals. The browser silently drops contexts (`webglcontextlost` fires), terminals go black, and there is no automatic recovery.

**Why it happens:**
The `WebglAddon` is the obvious performance choice for a single terminal. Developers add it to every terminal instance without accounting for the multiplicative effect.

**How to avoid:**
- Use the `CanvasAddon` (2D canvas, one context per terminal but much higher browser limits) as the default renderer.
- Alternatively implement a shared-WebGL-context approach: one ever-growing off-screen WebGL canvas, using `gl.scissor` + `gl.viewport` to render each terminal's region. This is complex but the only way to scale to 20+ terminals with WebGL.
- Add a runtime limit: if there are > N visible terminals, switch offscreen ones to DOM renderer.
- Listen for `webglcontextlost` and gracefully fall back to Canvas renderer per terminal.

**Warning signs:**
- Terminals go blank (black screen) as more nodes are added
- Browser DevTools console shows `WebGL: CONTEXT_LOST_WEBGL`
- Performance is excellent for the first ~10 terminals then suddenly degrades

**Phase to address:** Canvas + xterm integration phase; set renderer strategy before first demo

---

### Pitfall 7: xterm.js Scrollback Buffer Memory Growing Unbounded

**What goes wrong:**
Each xterm terminal defaults to 1000 lines of scrollback. With `claude` as the process (which can emit thousands of lines per session), a canvas with 10 active sessions can hold 10,000+ buffered lines in memory. Each line also keeps a reference tree in xterm's internal line buffer. On long sessions, the Tauri WebView memory balloons and may be killed by the OS.

**Why it happens:**
Default scrollback is generous for a single developer terminal. In a canvas multiplexer context, the default is applied to every terminal instance.

**How to avoid:**
Set `scrollback: 500` (or lower) in the Terminal constructor options for all terminal nodes. Expose a per-node "clear scrollback" button. For the parent Claude terminal (which is interactive), allow higher scrollback; for child `claude -p` terminals (single-task, non-interactive), set scrollback to 200 or 0 since the output is captured anyway.

**Warning signs:**
- `tauri` process RSS grows by 50–100 MB per terminal session over time
- App feels sluggish after 30+ minutes of parallel agent activity
- System OOM killer terminates the app

**Phase to address:** Canvas + xterm integration phase

---

### Pitfall 8: React Flow Re-rendering All Terminal Nodes on Any State Change

**What goes wrong:**
React Flow stores all nodes in a single array. Any update — moving a node, adding an edge, updating one node's data — causes the `nodes` array reference to change. If any component subscribes to the full `nodes` array (e.g., `const nodes = useNodes()`), all node components re-render. Terminal node components that re-render detach and re-attach xterm, which causes a visible flash and resets the viewport.

**Why it happens:**
It is natural to read node state with `useNodes()` in a parent component and pass data down as props. The `applyNodeChanges` helper creates a new array on every call, breaking reference equality.

**How to avoid:**
- Wrap every custom terminal node component in `React.memo`.
- Never use `useNodes()` inside a terminal node component. Use `useNodeId()` to get the id, then use a Zustand selector that reads only that node's data: `useStore(useShallow((s) => s.nodeMap[id]))`.
- Keep the xterm `Terminal` instance in a `useRef`, never in component state, so re-renders never recreate the terminal.
- Declare `nodeTypes` outside the `ReactFlow` component or memoize with `useMemo` — if `nodeTypes` is an object literal created inline, React Flow destroys and recreates every node on each parent render.

**Warning signs:**
- Terminal flashes/blinks when any node is dragged
- xterm output is reset when a new node is added to the canvas
- React DevTools Profiler shows 100% of nodes re-rendering on every drag event

**Phase to address:** Canvas + react-flow integration phase (same phase as xterm integration)

---

### Pitfall 9: `spawn_agent` Blocking Tool Causing MCP Client Timeout

**What goes wrong:**
`spawn_agent` is designed to block the parent claude's MCP tool call until the child `claude -p` finishes. A child `claude -p` on a non-trivial task can run for 5–15 minutes. The MCP client in the parent claude has a default idle timeout of 60 seconds (the MCP TypeScript SDK default). If no MCP progress notification is sent for 60 seconds, the client aborts the tool call with error `-32001`. The parent claude then thinks `spawn_agent` failed, but the child process is still running in the background, leaking a zombie agent.

**Why it happens:**
The MCP spec's default `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000` is reasonable for fast tools. `spawn_agent` is not a fast tool — it is a process-lifetime wrapper. This mismatch is invisible during early testing with short tasks.

**How to avoid:**
- Emit MCP progress notifications from the `spawn_agent` handler every 10–15 seconds while the child runs: `server.sendNotification("notifications/progress", { progressToken, progress: bytesRead, total: -1 })`. This resets the idle timer.
- Configure `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` in the environment when launching the parent claude to disable the idle timeout check.
- Additionally accept the `--max-turns` limit as a safeguard so a child cannot run forever.
- Track in-flight child PIDs server-side; on timeout signal or MCP disconnect, kill the child.

**Warning signs:**
- Parent claude reports `spawn_agent` failed with timeout, but a `claude` process is still visible in `htop`
- MCP logs show `-32001 Request Timeout` at exactly 60s, 5m, or 30m intervals
- The canvas shows a child terminal that completed work but the parent never received the result

**Phase to address:** MCP server + spawn_agent phase (must be solved before any multi-agent test)

---

### Pitfall 10: stdio Cannot Route Back to the Embedded App — Wrong MCP Transport Choice

**What goes wrong:**
If the embedded MCP server uses `stdio` transport, `claude` would need to be launched as a _child process of the MCP server_ so its stdin/stdout become the transport pipes. But in Turbo the child `claude` is the MCP _client_ and the Tauri app is the MCP _server_. You cannot use stdio transport for a server that must receive connections from independently-spawned processes. Using stdio here either requires a reverse-direction pipe hack (fragile) or simply does not work.

**Why it happens:**
`stdio` is the default transport in all MCP examples and tutorials. Developers try to use it without thinking through the direction of the connection.

**How to avoid:**
Use HTTP + Streamable HTTP (or legacy SSE) transport for the embedded MCP server. Bind on `127.0.0.1` only (no external exposure). The parent claude is configured to connect to `http://127.0.0.1:<PORT>/mcp`. The Tauri app starts the HTTP server before launching any `claude` process and passes the server URL via `--mcp-config` or a `.mcp.json` file written to the project's cwd. Note: classic HTTP+SSE (legacy) was deprecated in the MCP spec 2025-03-26; prefer Streamable HTTP if the rust MCP SDK supports it.

**Warning signs:**
- Attempting to start the embedded MCP server and connect to it from a spawned `claude` process fails with "transport not found" or "connection refused"
- `claude` MCP config points to a stdio server but no parent/child relationship exists between the processes

**Phase to address:** MCP server bootstrap phase (architectural decision; must be made before any MCP code is written)

---

### Pitfall 11: Concurrent `spawn_agent` Calls and MCP Response Routing Confusion

**What goes wrong:**
A parent claude might call `spawn_agent` multiple times in parallel (e.g., spawning 3 agents simultaneously). Each call blocks. If the MCP server uses a single shared server instance with naive request routing, responses from child 2's completion can be routed to child 1's waiting handler. The MCP spec requires per-connection server instances for HTTP transports; sharing a server instance causes response misrouting.

**Why it happens:**
The instinct is to create one global MCP server object and register it. The MCP spec (and the TypeScript SDK) explicitly requires creating a new server instance per connection.

**How to avoid:**
For each incoming HTTP connection to the MCP endpoint, create a fresh server instance. Maintain a registry `Map<requestId, ChildHandle>` to correlate `spawn_agent` calls with running children. Each `spawn_agent` call gets a unique `progressToken`; progress notifications are keyed on that token. Test explicitly with 3 simultaneous `spawn_agent` calls.

**Warning signs:**
- One agent's output appears in another agent's terminal
- Parent claude receives result A when it called for result B
- Race condition in response delivery that is hard to reproduce

**Phase to address:** MCP server phase; must be part of the initial concurrency design

---

### Pitfall 12: Quoting / Shell-Injection When Building the `claude -p` Command

**What goes wrong:**
The `spawn_agent(task, label)` tool receives a task string that comes from the parent claude's reasoning. This string may contain quotes, backticks, `$()`, newlines, or other shell metacharacters. If you build the child command as a shell string and pass it through `bash -c`, the task content can escape quoting and execute arbitrary shell commands inside the child's shell context. Even without malicious intent, a task like `"Fix the bug in 'main.rs'"` breaks naive single-quoted wrapping.

**Why it happens:**
The easy implementation is `Command::new("bash").arg("-c").arg(format!("claude -p '{}'", task))`. This is injection-vulnerable.

**How to avoid:**
Never construct the command via shell. Use `Command::new("claude").args(["-p", &task, "--output-format", "json"])` — pass the task as a separate argument, not as part of a shell string. Rust's `std::process::Command` with `.args()` passes each item directly to `execvp`, bypassing the shell entirely. The `--output-format json` and `--max-turns` flags should also be separate args.

**Warning signs:**
- Tasks with apostrophes or backticks in the description cause the child process to fail or behave unexpectedly
- A task string causes the child to run a different command than intended

**Phase to address:** MCP server / spawn_agent implementation phase

---

### Pitfall 13: Child `claude` Processes Becoming Orphans When the App Closes

**What goes wrong:**
When Tauri exits (window close, `tauri::AppHandle::exit()`), it does not automatically kill child processes that were spawned via `portable-pty`. The `claude` child processes — and their own subprocesses (node, git, bash) — remain running. On Hyprland, they are invisible. Over multiple sessions, dozens of orphaned `claude` processes accumulate, consuming tokens (if still running) and RAM.

**Why it happens:**
Rust `Drop` implementations don't kill child processes by default on the tokio runtime — tokio only makes a best-effort reap. `portable-pty`'s `Child` must be explicitly waited or killed. Tauri's `on_window_event` close handler is easy to forget.

**How to avoid:**
- Maintain a global `Arc<Mutex<HashMap<NodeId, Box<dyn ChildKiller>>>>` registry in Tauri app state.
- On Tauri's `CloseRequested` window event, iterate the registry and call `killer.kill()` on each child, then wait. Use a 3-second timeout; force-kill if they don't exit.
- Also handle `SIGTERM` via `ctrlc` crate.
- Test explicitly: open 5 terminals, close the app, verify no `claude` processes remain in `ps aux`.

**Warning signs:**
- `ps aux | grep claude` shows processes after the app closes
- Repeated test runs accumulate background processes
- Anthropic API usage dashboard shows unexpected token consumption after sessions

**Phase to address:** PTY foundation phase; process lifecycle must be designed before any UI work

---

### Pitfall 14: Recursive Child Spawning — Grandchildren Spawning Great-grandchildren

**What goes wrong:**
A child `claude -p` instance, when run with access to the same `.mcp.json` that points to the Turbo MCP server, can call `spawn_agent` itself, spawning grandchild claude processes. Those grandchildren can spawn further. Without a depth guard, a runaway child can fan out exponentially, generating thousands of tokens per second and dozens of orphaned processes. Claude Code v2.1.172+ enforces a 5-level recursion limit internally for its own Agent tool, but a _custom_ `spawn_agent` tool in your MCP server has no such guard unless you implement one.

**Why it happens:**
Child `claude` processes inherit the environment and the `.mcp.json` configuration. The `spawn_agent` tool is available to every claude instance that connects to the server, including children.

**How to avoid:**
- Pass a `--depth N` header or include a depth field in the `spawn_agent` tool schema. The server tracks the depth and returns an error if a call would exceed depth 2 (children only; no grandchildren) or whatever limit is chosen.
- Alternatively, write a different `.mcp.json` for child processes that does not include `spawn_agent`, or passes a modified server URL with a depth-capped endpoint.
- Set `--max-turns 50` on all child invocations so a runaway child self-terminates.

**Warning signs:**
- Unexpected `claude` processes in htop beyond what the canvas shows
- Anthropic API costs spike unexpectedly
- The MCP server logs show `spawn_agent` calls with no corresponding canvas node

**Phase to address:** MCP server phase; implement the depth guard before any real agent test

---

### Pitfall 15: Wayland / NVIDIA Blank Window (DMABUF Renderer)

**What goes wrong:**
On Arch Linux with NVIDIA proprietary drivers (any version before 545 without `nvidia_drm.modeset=1`, or any version without explicit sync support), WebKitGTK's DMABUF renderer fails silently or crashes with `Error 71 (Protocol error) dispatching to Wayland display`. The Tauri window opens but shows a blank/white screen. The app appears to start (logs flow) but nothing renders. This is a WebKitGTK + NVIDIA + Wayland interaction, not a Tauri bug per se, but it affects every Tauri v2 app on this setup.

**Why it happens:**
WebKitGTK prefers hardware-accelerated DMABUF rendering. NVIDIA's Wayland DMABUF support has historically been incomplete. Tauri does not set environment variables to work around this automatically.

**How to avoid:**
In `main()` before `tauri::Builder::default()`, set environment variables programmatically:
```rust
std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1"); // try first
// if still blank: 
std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
```
Tauri's official documentation recommends this exact approach so users don't need to set them manually. Also ensure the user has `nvidia_drm.modeset=1` in their kernel parameters. Since Turbo is a personal tool for vings' Arch/Hyprland setup, document these in a local `README-dev.md`.

**Warning signs:**
- App window opens blank immediately on launch
- `journalctl` shows `AcceleratedSurfaceDMABuf was unable to construct a complete framebuffer`
- The Tauri app works on X11 (`WAYLAND_DISPLAY` unset) but not under Hyprland

**Phase to address:** Project bootstrap (Phase 0 / very first Tauri shell); set these env vars in the skeleton app before writing any other code

---

### Pitfall 16: MCP `spawn_agent` Tool Timeout — Progress Notifications Are the Fix

**What goes wrong:**
(Extends Pitfall 9) Even if `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` is set to 0, the parent claude's context window fills up while waiting for a long-running child, causing an implicit turn limit. If the tool response never arrives (child hangs), the parent claude eventually gives up and either retries (spawning a duplicate child) or abandons the task. The duplicate child is now running in parallel with the hung one.

**How to avoid:**
The `spawn_agent` server handler must implement a heartbeat: send MCP progress notifications every 10s. Also implement a wall-clock timeout per child: if a child runs longer than `MAX_AGENT_RUNTIME` (e.g., 10 minutes), kill it and return a partial-result error to the parent. The `--max-turns` flag on `claude -p` children is the primary safeguard; set it conservatively (e.g., 100 turns).

**Warning signs:**
- Parent claude logs show "tool call timed out" after a configurable interval
- Two canvas nodes appear for what should be one agent
- A child terminal continues to run after the parent has moved on

**Phase to address:** MCP server phase (same as Pitfall 9; address together)

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| `String::from_utf8_lossy()` for PTY bytes | Simple Rust code | Corrupts multi-byte UTF-8 at chunk boundaries | Never — always use streaming TextDecoder on JS side or emit raw bytes |
| One `WebglAddon` per terminal | Best rendering quality | WebGL context exhaustion beyond ~10 terminals | Only if the app will never show more than 8 terminals simultaneously |
| Read PTY output synchronously in async fn | Simpler code | Blocks Tokio runtime thread, freezes IPC | Never — always spawn_blocking |
| `useNodes()` inside terminal node components | Easy state access | All terminals re-render on every canvas change | Never — use per-node Zustand selectors |
| `nodeTypes` defined as an inline object literal | Convenient | Every parent render destroys and recreates all nodes | Never — declare outside component or useMemo |
| stdio MCP transport for embedded server | Matches all tutorials | Impossible to connect from independently-spawned claude processes | Never for this architecture |
| Skip depth guard on `spawn_agent` | Simpler server code | Unbounded recursion, exponential token cost | Never — implement before any real test |
| Shared MCP server instance for all HTTP connections | Simpler code | Response misrouting in concurrent `spawn_agent` calls | Never — new server instance per connection |
| Not killing PTY children on app close | Simpler shutdown | Orphaned `claude` processes accumulate between sessions | MVP only if tests verify they self-terminate; remove before daily use |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Tauri ↔ PTY byte stream | Serialize bytes as JSON string via `String::from_utf8_lossy` | Emit as binary (`Vec<u8>`) via Tauri Channel or base64; decode with `TextDecoder({stream: true})` on JS side |
| xterm.js ↔ React Flow node | Create `new Terminal()` in component body (recreated on re-render) | Create terminal in `useRef`; initialize once in `useEffect` with empty deps |
| FitAddon ↔ canvas zoom | Call `fit()` on every transform matrix change | Debounce `fit()` behind `ResizeObserver`; never call on zoom change, only on layout resize |
| MCP client (claude) ↔ embedded server | Use stdio transport (default in all examples) | Use HTTP/Streamable HTTP on `127.0.0.1`; pass URL via `.mcp.json` in the project cwd |
| `spawn_agent` ↔ long child runtime | No progress notifications → 60s idle timeout kills the call | Send MCP progress notification every 10s from the child-watcher loop |
| `claude -p` ↔ shell command construction | Build command as shell string: `bash -c "claude -p '${task}'"` | Use `Command::new("claude").args(["-p", &task])` — no shell interpolation |
| `claude` child ↔ MCP server reachability | Child inherits cwd but not the running app's MCP server URL | Write `.mcp.json` to the project cwd before launching each child |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| One WebGL context per xterm terminal | Terminals go black as count increases | Use CanvasAddon or shared-WebGL approach | > 8–12 simultaneous visible terminals |
| Unbounded scrollback (default 1000 lines) | RSS grows 50–100 MB per long session | Set `scrollback: 200` for child terminals | After 1+ hour of parallel agent activity |
| React state for PTY chunk stream | UI jank, dropped frames | Buffer in Ref; drain with rAF → xterm.write() | From the first large output (> 10 KB/s) |
| `useNodes()` in terminal nodes | All terminals re-render on drag | Per-node Zustand selector + React.memo | Any canvas with > 3 terminals |
| Synchronous PTY read in async context | IPC commands freeze | spawn_blocking per terminal reader | Immediately with 2+ active terminals |
| PTY reader thread leaking after node deletion | Rust thread count grows; memory leak | Cancel reader on node removal via an abort flag | After removing 10+ nodes in a session |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| MCP server bound on `0.0.0.0` | Any local process can call `spawn_agent` and spawn arbitrary `claude` instances | Bind exclusively on `127.0.0.1`; reject requests without a shared secret header |
| Passing task string through shell (`bash -c "claude -p '$task'"`) | Shell injection from task content containing `'`, `$(...)`, backticks | Use `Command::new("claude").args(["-p", &task])` — no shell |
| Children inherit all environment vars including `ANTHROPIC_API_KEY` | A malicious child prompt could exfiltrate the API key | Expected behavior for this personal tool; acceptable. If ever sharing, spawn children with a restricted env. |
| No recursion depth guard on `spawn_agent` | Prompt injection in a task could instruct the child to spawn grandchildren with attacker tasks | Implement server-side depth counter; reject depth > 2 |

---

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| No visual indication of child terminal "running vs done" | vings can't tell which agents are still working | Add a status badge on each terminal node (Running / Done / Error) driven by process exit code |
| Terminal node size not persisted after resize | Every session starts with default-sized nodes | Persist node dimensions in local storage or Tauri store |
| Canvas zoom affects terminal font size visually (WebGL blur) | Text looks blurry when zoomed out | Render at logical size; accept that extreme zoom out blurs text (inform user) |
| Closing a terminal node while `spawn_agent` is in-flight leaves parent claude stuck | Parent gets no response ever | On terminal node close: kill the child process AND return an error result to the waiting MCP call |
| No way to abort a runaway child agent | Costs accumulate; can't stop it without killing entire app | Add a "Kill" button per terminal node that sends SIGTERM + closes the PTY |

---

## "Looks Done But Isn't" Checklist

- [ ] **PTY resize:** Terminal visually resizes, but verify `stty size` inside the terminal returns the new dimensions
- [ ] **UTF-8 streaming:** Demo output looks fine with ASCII, but test by piping `printf '\xE4\xB8\xAD\xE6\x96\x87'` across a chunk boundary (emit 2 bytes, then 2 more)
- [ ] **Orphan cleanup:** App closes cleanly, but verify `ps aux | grep claude | grep -v grep` shows zero results after close
- [ ] **MCP timeout on long tasks:** `spawn_agent` works on a 10-second task, but test with a 5-minute task to confirm progress notifications prevent timeout
- [ ] **Recursive guard:** `spawn_agent` works from the parent, but verify a child calling `spawn_agent` is rejected or depth-limited
- [ ] **Concurrent spawn:** One `spawn_agent` works, but spawn 3 simultaneously and verify each receives the correct result
- [ ] **WebGL limits:** One terminal renders fine; test with 15 simultaneous terminals to confirm no context loss
- [ ] **React Flow memo:** Dragging a node doesn't flash other terminals (check React DevTools Profiler)
- [ ] **Wayland blank window:** App renders on first run on Hyprland without any manual env var export

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Orphan processes already accumulated | LOW | `pkill -f 'claude -p'` in terminal; add cleanup to app startup that checks for orphans |
| WebGL context loss discovered late | MEDIUM | Switch from WebglAddon to CanvasAddon globally; 1-line config change per terminal |
| UTF-8 corruption discovered in production use | MEDIUM | Patch Tauri emit to send `Vec<u8>` as binary; update JS decode; no architecture change |
| MCP timeout blocking all agent tests | LOW | Set `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` as immediate unblock; add progress notifications properly in next sprint |
| `nodeTypes` inline → all terminals recreate on any state change | MEDIUM | Move `nodeTypes` out of render; xterm instances must be re-attached (one-time refactor) |
| stdio MCP chosen, then discovered it can't work | HIGH | Full MCP server rewrite to HTTP; architectural; should not happen if caught in planning |
| Recursive spawning happened in a test | LOW | Kill all claude processes; add depth guard to server before next test |
| FitAddon resize loop discovered under heavy use | LOW | Add debounce + guard check; 10-line patch |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Blocking PTY read (P1) | Phase 1: PTY foundation | `yes` pipe stress test; IPC response time stays < 100ms |
| PTY backpressure (P2) | Phase 1: PTY foundation | Flood test: 10 MB stdout burst; no data drop, no freeze |
| UTF-8 chunk corruption (P3) | Phase 1: PTY foundation | CJK + emoji split-boundary unit test in Rust + JS |
| SIGWINCH not sent (P4) | Phase 2: xterm integration | `stty size` test after every resize |
| FitAddon resize loop (P5) | Phase 2: canvas + xterm | ResizeObserver callback count stays bounded; no `loop limit` warning |
| WebGL context exhaustion (P6) | Phase 2: canvas + xterm | Open 15 terminals; none go blank |
| Scrollback memory (P7) | Phase 2: canvas + xterm | RSS after 1h parallel activity < 500 MB |
| React Flow re-render cascade (P8) | Phase 2: canvas | React Profiler shows zero re-renders on other terminals while dragging one |
| `spawn_agent` timeout (P9, P16) | Phase 3: MCP server | 10-minute child test with no timeout; verify progress notifications logged |
| Wrong MCP transport (P10) | Phase 3: MCP server | Architecture decision locked before any code; HTTP-only |
| Concurrent spawn routing (P11) | Phase 3: MCP server | 3 simultaneous `spawn_agent` calls return correct results to correct callers |
| Shell injection in child command (P12) | Phase 3: MCP server | Task string with `'; rm -rf /tmp/test'` does not execute |
| Orphan processes on close (P13) | Phase 1: PTY foundation | `ps aux` after 5 terminals closed shows no claude processes |
| Recursive spawning (P14) | Phase 3: MCP server | Child calling `spawn_agent` is rejected or depth-capped |
| Wayland blank window (P15) | Phase 0: Tauri skeleton | App renders on first `cargo tauri dev` run in Hyprland without extra exports |

---

## Sources

- [xterm.js Issue #4379 — WebGL context limit for many terminals](https://github.com/xtermjs/xterm.js/issues/4379)
- [xterm.js Issue #4841 — FitAddon resizes incorrectly](https://github.com/xtermjs/xterm.js/issues/4841)
- [xterm.js Issue #2662 — Renderer blurry when window zoom changes](https://github.com/xtermjs/xterm.js/issues/2662)
- [portable-pty docs.rs — PtySize, resize, ChildKiller APIs](https://docs.rs/portable-pty/latest/portable_pty/)
- [pty-process crate — async PTY wrapper for Tokio](https://docs.rs/pty-process/latest/pty_process/)
- [tokio::process Child docs — zombie reaping best-effort notes](https://docs.rs/tokio/latest/tokio/process/struct.Child.html)
- [React Flow Performance docs — useNodes anti-pattern, React.memo, Zustand selectors](https://reactflow.dev/learn/advanced-use/performance)
- [xyflow Issue #4983 — Non-changed nodes re-render despite React.memo](https://github.com/xyflow/xyflow/issues/4983)
- [MCP Issue #671 (python-sdk) — stdio tool hang on external scripts](https://github.com/modelcontextprotocol/python-sdk/issues/671)
- [Claude Code Issue #22542 — MCP tool execution timeout not configurable](https://github.com/anthropics/claude-code/issues/22542)
- [Claude Code Issue #58687 — MCP client times out long-running tools despite progress notifications](https://github.com/anthropics/claude-code/issues/58687)
- [Claude Code Issue #68110 — Recursive sub-agents exponential fan-out](https://github.com/anthropics/claude-code/issues/68110)
- [Tauri Linux Graphics Issues (official) — DMABUF, NVIDIA, Wayland workarounds](https://v2.tauri.app/develop/debug/linux-graphics/)
- [Tauri Issue #10746 — Window not focused on creation, Wayland](https://github.com/tauri-apps/tauri/issues/10746)
- [MCP Transport comparison — stdio concurrency single-threaded bottleneck](https://startdebugging.net/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/)
- [Node.js UTF-8 stream fix — streaming TextDecoder for chunk boundaries](https://github.com/nodejs/node/commit/a5b1be2045)
- [Claude Code Issue #23740 — Shell quoting escaping issues in non-interactive mode](https://github.com/anthropics/claude-code/issues/23740)
- [Claude Code headless docs — -p flag, --output-format json, --max-turns](https://code.claude.com/docs/en/headless)

---
*Pitfalls research for: Turbo — Canvas de Agentes (PTY + xterm.js + react-flow + embedded MCP + claude children)*
*Researched: 2026-08-04*
