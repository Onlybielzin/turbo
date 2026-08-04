# Feature Research

**Domain:** Infinite canvas + live terminal nodes + agent orchestration (personal desktop app)
**Researched:** 2026-08-04
**Confidence:** HIGH

---

## Reference Points Used

- **Terminal multiplexers**: tmux, Zellij — pane management, session persistence, scrollback, status bars
- **Agent orchestration UIs**: Claude Code Agent View, AgentsRoom, Hermes Studio — parent/child hierarchy, status indicators, queue management
- **Node/canvas apps**: Figma, tldraw, n8n, ComfyUI — pan/zoom, minimap, grouping, frames, edge/wire drawing
- **Terminal-in-canvas**: OpenCove (xyflow + xterm.js + node-pty), tauri-terminal — closest existing art to Turbo
- **Stack context**: Tauri + React + xyflow/react-flow + xterm.js (already decided)

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features the tool must have or the core value proposition breaks. These are the minimum for the concept to make sense at all.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Infinite pan and zoom | Every canvas app since Figma. Without it you cannot position and view multiple nodes simultaneously | LOW | react-flow provides d3-zoom out of the box; no custom work needed |
| Drag nodes freely on canvas | How you position terminals spatially; without drag you have a list, not a canvas | LOW | react-flow built-in; custom node type wraps xterm.js |
| Live terminal node with PTY streaming | Core value: seeing each Claude instance running in real time. Dead/static terminal negates the point | HIGH | Rust side: `portable-pty` spawns PTY, bridges via Tauri events. Front: xterm.js renders stream |
| Keyboard input forwarded into terminal node | Without input the terminal is read-only — useless for interactive `claude` sessions | MEDIUM | Input events from xterm.js captured, sent via Tauri invoke to Rust, written to PTY master |
| `spawn_agent` MCP tool (embedded server) | The orchestration mechanism. Without it the parent Claude cannot create child agents | HIGH | HTTP+SSE MCP server running in Tauri backend. Tool call creates new terminal node + starts `claude -p` |
| Blocking `spawn_agent` return | Semantics the parent expects: call returns when child finishes, with child's final stdout. Non-blocking makes orchestration incoherent | HIGH | Rust task blocks until child process exits; result serialized back as MCP tool response |
| Parent → child edges drawn on canvas | The visual tree. Without edges you cannot see who spawned whom — just a field of terminals | MEDIUM | react-flow edges between node IDs; stored alongside node positions |
| Terminal status indicator (running / finished / error) | Users need to know at a glance if a child is still working or done. Tmux and every multiplexer does this | LOW | Derive from PTY exit code; color badge on node header (green/gray/red) |
| Kill / clean up PTYs on app close | Without this, zombie claude processes accumulate. Zellij and tmux both manage this explicitly | MEDIUM | Tauri's `on_exit` / drop handler iterates DashMap of sessions, sends SIGHUP/SIGKILL |
| Multiple project groups with separate cwd | Core multi-project capability. Each group is its own orchestration tree with its own parent Claude and working directory | MEDIUM | Group = react-flow parent node ("frame") containing child nodes; launched with `cwd` per group |
| Node resize | xterm.js terminals must fit their allocated space. Mismatched sizes corrupt ANSI rendering | MEDIUM | `addon-fit` + react-flow NodeResizer; PTY resize via `portable-pty`'s `resize` API |

### Differentiators (What Makes Turbo Turbo)

Features that go beyond "nice terminal multiplexer" and make this specifically a visual agent cockpit. These are what the tool is for.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Spawn-tree visualization (edges auto-drawn on `spawn_agent` call) | You see the orchestration graph materialize in real-time as the parent spawns children. No existing tool does this live | MEDIUM | MCP tool handler emits event → front adds edge + new node at offset from parent node position |
| Group / frame node containing its own parent + children | Maps naturally to "project": one frame per repo/task, parent Claude at top, children below. Spatial grouping makes multi-project legible | MEDIUM | react-flow sub-flows / parentNode concept; frame node acts as viewport boundary for the group |
| MCP tool result streaming back into parent terminal | Parent sees child output arrive without polling — the blocking call returns but interim lines stream live into the child's terminal while the parent waits | HIGH | Dual channel: PTY events stream to UI continuously; MCP response only resolves on exit. Complex to orchestrate |
| Node header shows task label from `spawn_agent(task, label)` | Each child node gets a human-readable label from the parent call, making the tree self-documenting without extra UI | LOW | Label field on node data; rendered in node header |
| Canvas persistence (save/restore layout on relaunch) | Restore exactly the spatial state: which groups, which nodes, where, what status. OpenCove does this; it is expected for a serious personal tool | MEDIUM | Serialize react-flow node/edge state + group metadata to JSON on disk (e.g. `~/.config/turbo/canvas.json`); reload on start |
| Per-group cwd config persisted | Each frame/group remembers its working directory across relaunches | LOW | Part of the canvas JSON; key on group node data |

### Anti-Features (Deliberately NOT Building for v1)

Features that seem useful but would derail a focused v1 or contradict the out-of-scope decisions already made in PROJECT.md.

| Feature | Why Requested | Why Problematic for v1 | Alternative / What to Do Instead |
|---------|---------------|------------------------|----------------------------------|
| Authentication / login | "Make it shareable" | Single-user personal tool on localhost. Auth adds weeks of infra work for zero personal value | Bind MCP server to `127.0.0.1` only; no auth needed |
| Multi-user / collaboration (tldraw sync, Cloudflare DO) | "Like Figma teams" | Requires conflict resolution, presence, sync infra. Totally out of scope for a personal cockpit | Canvas state is local JSON; no sync needed |
| Cloud sync / remote state | "Access from anywhere" | Adds storage backend, auth, and network dependency. The whole app is local-first | Use local filesystem; back up with standard tools if desired |
| Generic shell terminals (bash, zsh, non-Claude nodes) | "While we're at it, make it a full terminal multiplexer" | Dilutes the agent-cockpit identity. Scope creep that competes with Zellij/tmux for no reason | Nodes run `claude`; if you want a shell, open Ghostty |
| Fire-and-forget agents (non-blocking `spawn_agent`) | "Let parent continue immediately" | Already rejected in PROJECT.md. Non-blocking undermines orchestration semantics — parent cannot synthesize results | Stick to blocking; parent waits and synthesizes |
| Hybrid mode: detach agent to native Hyprland window | "Flexibility" | Complex IPC between Wayland compositor and app, unclear UX, already rejected in PROJECT.md | All terminals live on the canvas, full stop |
| Auto-layout / DAG layout engine | "Arrange the tree automatically" | Fights user's manual spatial positioning; complex to implement without annoying users who have placed nodes deliberately | User drags nodes; default placement is "offset from parent" on spawn |
| Replay / history / time-travel of agent runs | "Debug what happened" | Requires persisting PTY stream to disk, indexing, replay engine — huge scope. xterm.js scrollback covers the immediate need | Scrollback buffer (configurable, e.g. 10 000 lines) covers recent history |
| Plugin system / extensible node types | "Make it extensible" | v1 has one node type: Claude terminal. Plugin API is premature abstraction | Hard-code the terminal node; extract plugin boundary in v2 if needed |
| Packaged installer / AppImage / Flatpak | "Distribute to others" | Personal tool; distributable packaging is out of scope per PROJECT.md | `cargo tauri dev` / `cargo tauri build` for local use only |
| Notifications / webhook integrations | "Alert me when an agent finishes" | Status is visible on canvas by design. Notifications for a visible window are redundant | Node status badge + terminal bell (xterm.js `bellStyle`) |
| Dark/light theme toggle | "Accessibility" | Personal tool on one machine. Hardcode a dark theme consistent with Hyprland setup | Ship one theme; revisit in v2 if the tool opens up |
| Minimap | "Navigate large canvases" | react-flow provides `<MiniMap>` out of the box — but only add it if the canvas becomes genuinely large. Not needed for early validation | Add as a low-cost enhancement once the canvas has >10 nodes regularly |

---

## Feature Dependencies

```
[Canvas pan/zoom/drag]                     — foundation; nothing else renders without it
    └──requires──> [react-flow setup + custom TerminalNode type]
                       └──requires──> [xterm.js instance inside React node]
                                           └──requires──> [PTY bridge: Tauri events pty_output → xterm.js write]

[Live PTY streaming to terminal node]
    └──requires──> [PTY bridge]
    └──requires──> [Tauri Rust backend: portable-pty + DashMap sessions]

[Keyboard input into terminal]
    └──requires──> [PTY bridge (write direction: xterm.js onData → Tauri invoke → PTY write)]
    └──requires──> [Live PTY streaming] (same session)

[spawn_agent MCP tool]
    └──requires──> [Embedded MCP HTTP+SSE server in Tauri backend]
    └──requires──> [PTY bridge] (to spawn and stream child)
    └──requires──> [Canvas node creation API] (to add node programmatically from Rust event)
    └──requires──> [Keyboard input + Live PTY streaming] (child must be a full interactive terminal)

[Blocking spawn_agent return]
    └──requires──> [spawn_agent MCP tool]
    └──requires──> [PTY process exit detection] (watch for EOF / exit code on child PTY)

[Parent→child edges]
    └──requires──> [spawn_agent MCP tool] (edges are created at spawn time)
    └──requires──> [Canvas node creation API]

[Node status indicator]
    └──requires──> [PTY process exit detection]
    └──enhances──> [Parent→child edges] (color edge by child status)

[Node resize]
    └──requires──> [xterm.js instance]
    └──requires──> [PTY resize API] (portable-pty resize)
    └──enhances──> [Live PTY streaming] (correct ANSI column width)

[Group/frame node with cwd]
    └──requires──> [Canvas pan/zoom/drag]
    └──requires──> [react-flow sub-flows / parentNode]
    └──enhances──> [spawn_agent MCP tool] (parent Claude launched with group's cwd)

[Canvas persistence]
    └──requires──> [Group/frame node]
    └──requires──> [All node/edge state serializable to JSON]
    └──enhances──> [Per-group cwd config]

[Kill PTYs on close]
    └──requires──> [PTY bridge + DashMap sessions]
    └──requires──> [Tauri on_exit hook or window close event]

[Task label on node header]
    └──requires──> [spawn_agent MCP tool] (label comes from tool call argument)
    └──requires──> [Custom TerminalNode type with header]

[MCP tool result streaming to UI while blocking]
    └──requires──> [spawn_agent MCP tool]
    └──requires──> [Live PTY streaming] (child's output is already streaming)
    └──conflicts──> none (streaming to UI and blocking MCP response are independent channels)
```

### Dependency Notes

- **PTY bridge is the critical path**: everything terminal-related (streaming, input, resize, kill, spawn_agent) depends on the Rust PTY bridge being solid before any UI work is meaningful.
- **spawn_agent requires canvas node creation from Rust**: the MCP tool handler (Rust) must be able to tell the React front-end to add a new node. This is the main Rust-to-front IPC design challenge.
- **Group/frame node is a prerequisite for multi-project**: without frames, groups are just a visual convention with no structural meaning and cwd cannot be scoped correctly.
- **Canvas persistence depends on everything being serializable**: node positions, edge IDs, group cwd, and node status must all be reducible to plain JSON — this is easy with react-flow's `toObject()` but node identity (session IDs) must survive across relaunches.
- **Node resize and PTY resize must stay in sync**: if the user resizes the node visually but PTY is not notified, ANSI output will wrap incorrectly. Use `addon-fit` + PTY resize as a unit.

---

## MVP Definition

### Launch With (v1) — directly from PROJECT.md Active requirements

- [ ] Canvas with pan, zoom, drag — foundation for everything
- [ ] Terminal node: live PTY streaming + keyboard input + status indicator
- [ ] Embedded MCP server exposing `spawn_agent(task, label)`
- [ ] Blocking `spawn_agent`: creates child terminal node, runs `claude -p`, returns output to parent
- [ ] Parent → child edges drawn automatically on spawn
- [ ] Group/frame nodes: each group has its own cwd and its own parent Claude
- [ ] Kill/cleanup PTYs on app close (no zombies)
- [ ] Node resize (PTY resize in sync)
- [ ] Task label on node header (from `spawn_agent` call)

### Add After Validation (v1.x)

- [ ] Canvas persistence (save/restore layout on relaunch) — add once the tool is used daily and losing layout becomes painful
- [ ] Configurable scrollback buffer size — add once default 1 000 lines proves insufficient
- [ ] Minimap — add once canvas regularly has >10 nodes
- [ ] Edge color by child status (running/done/error) — polish after core orchestration is proven

### Future Consideration (v2+)

- [ ] MCP tool result interim streaming (separate from terminal stream) — complex dual-channel; only needed if parent-side UX requires richer progress
- [ ] Hybrid mode: detach node to Hyprland native window — already rejected for v1; reconsider if canvas layout becomes limiting
- [ ] Configurable themes — only if tool opens to other users
- [ ] Plugin system for custom node types — only if use cases beyond Claude terminals emerge

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Canvas pan/zoom/drag | HIGH | LOW | P1 |
| PTY bridge (streaming + input) | HIGH | HIGH | P1 |
| Terminal node (xterm.js in react-flow) | HIGH | MEDIUM | P1 |
| Embedded MCP server | HIGH | HIGH | P1 |
| Blocking spawn_agent | HIGH | HIGH | P1 |
| Parent→child edges | HIGH | LOW | P1 |
| Group/frame + cwd | HIGH | MEDIUM | P1 |
| Kill on close | HIGH | MEDIUM | P1 |
| Node status indicator | MEDIUM | LOW | P1 |
| Node resize + PTY resize | MEDIUM | MEDIUM | P1 |
| Task label on node header | MEDIUM | LOW | P1 |
| Canvas persistence | HIGH | MEDIUM | P2 |
| Scrollback buffer config | MEDIUM | LOW | P2 |
| Minimap | LOW | LOW | P2 |
| Edge color by status | LOW | LOW | P2 |
| Interim streaming to parent | MEDIUM | HIGH | P3 |
| Hybrid Hyprland window mode | LOW | HIGH | P3 |

---

## Competitor / Reference Analysis

| Feature | tmux/Zellij | Claude Code Agent View | OpenCove | Turbo (our approach) |
|---------|-------------|----------------------|----------|----------------------|
| Canvas / spatial layout | No — linear splits | No — list | Yes, xyflow | Yes, xyflow |
| Live terminal per agent | Yes | No — text status only | Yes | Yes |
| Spawn-tree edges | No | Implicit hierarchy only | No | Yes — drawn on spawn |
| Blocking agent call return | N/A | Yes (internal) | No | Yes — MCP blocking tool |
| Group / project isolation | Sessions (no cwd per group) | No | Partial | Yes — frame + cwd |
| Session persistence | Yes (tmux-resurrect plugin) | No | Yes | v1.x (P2) |
| Multi-project simultaneously | No (one session at a time) | No | No | Yes — multiple frames |
| Kill on close | Yes | Yes | Partial | Yes |

---

## Sources

- [Zellij vs tmux comparison 2026](https://dasroot.net/posts/2026/02/terminal-multiplexers-tmux-vs-zellij-comparison/)
- [Zellij features: floating panes, layout system, WASM plugins](https://www.fosslinux.com/156189/zellij-vs-tmux-the-modern-terminal-multiplexer-for-linux.htm)
- [React Flow / xyflow: minimap, sub-flows, NodeResizer](https://reactflow.dev/examples/overview)
- [React Flow MiniMap component](https://reactflow.dev/api-reference/components/minimap)
- [React Flow sub-flows / parentNode](https://reactflow.dev/learn/layouting/sub-flows)
- [xterm.js addon-fit, addon-webgl, scrollback](https://github.com/xtermjs/xterm.js/)
- [Claude Code Agent View — real-time subagent hierarchy](https://www.buildfastwithai.com/blogs/claude-code-agent-view-guide)
- [Claude Code subagents orchestrator pattern](https://www.channel.tel/blog/claude-code-subagents-orchestrator-pattern)
- [OpenCove: xyflow + xterm.js + node-pty, spatial agent canvas](https://github.com/DeadWaveWave/opencove)
- [Session persistence patterns: atomic JSON save/restore](https://deepwiki.com/ogulcancelik/herdr/3.2-session-persistence)
- [Tauri IPC: commands vs events, DashMap sessions, PTY on blocking thread](https://v2.tauri.app/concept/inter-process-communication/)
- [tauri-terminal reference implementation](https://github.com/marc2332/tauri-terminal)
- [DAG editor with SSE status per node — agent orchestration UIs](https://gerred.github.io/building-an-agentic-system/second-edition/part-iv-advanced-patterns/chapter-10-multi-agent-orchestration.html)
- [tldraw SDK: table-stakes features, copy/paste, undo/redo](https://tldraw.dev/)
- [MCP server silent spawn failures in Claude Code](https://github.com/nanocoai/nanoclaw/issues/2968)

---

*Feature research for: Turbo — infinite canvas agent cockpit*
*Researched: 2026-08-04*
