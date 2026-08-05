---
phase: 04-orquestra-o-mcp-integrada
plan: 04
subsystem: mcp
tags: [rmcp, tauri, mcp, pty, xterm, xyflow, streamable-http, spawn_agent, canvas]

requires:
  - phase: 03-canvas-terminal-nodes-grupos
    provides: GroupFrame, TerminalNode, store, usePty, canvas layout
  - phase: 02-spike-mcp
    provides: proven rmcp spawn_agent handler, run_in_pty_blocking, depth guard, progress heartbeat

provides:
  - Embedded rmcp MCP server (Streamable HTTP) running as tokio task in Tauri runtime
  - spawn_agent tool: creates child TerminalNode in canvas with parent→child edge, inside parent GroupFrame
  - create_group command: writes .mcp.json (D-02: after health-check) before claude starts
  - Radial fan layout for spawned child nodes (layout.ts)
  - pty_spawn env param: injects TURBO_GROUP_ID and TURBO_MCP_DEPTH into parent claude process
  - Concurrent spawn_agent support: each MCP call gets independent tokio task + spawn_blocking thread

affects: [future-phases, uat, orchestration]

tech-stack:
  added:
    - rmcp 0.8 (embedded MCP Streamable HTTP server via axum + tokio)
    - axum 0.8 (HTTP server powering rmcp transport)
    - uuid 1 (child node UUIDs)
    - tokio spawn_blocking (PTY read loop — no thread leak on cancel)
    - schemars 1.0 (JSON schema for MCP tool parameters)
  patterns:
    - D-02 ordering: create_group awaited before addTerminalNode; .mcp.json written before claude mounts
    - Arc<PtyManager> shared between Tauri commands and MCP handler
    - node_created Tauri event: MCP handler → canvas frontend, before blocking PTY call
    - Radial fan layout: FAN_RADIUS=380px, 144° arc for child nodes around parent
    - TURBO_GROUP_ID / TURBO_MCP_DEPTH env vars: explicit depth tracking (not ambient env)
    - spawn_blocking for all PTY-blocking ops inside async MCP handler

key-files:
  created:
    - app/src-tauri/src/mcp/mod.rs
    - app/src-tauri/src/mcp/server.rs
    - app/src-tauri/src/mcp/spawn_agent.rs
    - app/src-tauri/src/groups.rs
    - app/src/canvas/layout.ts
  modified:
    - app/src-tauri/src/lib.rs
    - app/src-tauri/Cargo.toml
    - app/src-tauri/Cargo.lock
    - app/src/canvas/Canvas.tsx
    - app/src/canvas/Toolbar.tsx
    - app/src/canvas/store.ts
    - app/src/canvas/usePty.ts
    - app/src/canvas/TerminalNode.tsx

key-decisions:
  - "create_group writes .mcp.json only (no PTY spawn) — usePty spawns claude AFTER create_group resolves, preserving D-02 ordering without channel-sharing complexity"
  - "env param on pty_spawn (Vec<[String;2]>) injects TURBO_GROUP_ID/DEPTH into parent claude process from the frontend"
  - "child nodes from spawn_agent are display-only (ptyId=null) — output returns to parent claude via MCP return value, not xterm"
  - "existingPtyId path retained in usePty for future attach-to-running-session use case"
  - "radial fan: FAN_RADIUS=380px, FAN_SPREAD=144° arc, single child goes directly right"

patterns-established:
  - "MCP D-02: always await create_group (mcp.json write) before adding TerminalNode — ordering enforced at Toolbar level"
  - "node_created event emitted BEFORE spawn_blocking so canvas shows child immediately"
  - "spawn_blocking wraps all portable-pty calls inside async MCP handler — no orphaned threads on cancel"
  - "explicit depth param in SpawnParams — never read TURBO_MCP_DEPTH from Tauri process ambient env"

requirements-completed: [ORCH-02, ORCH-03, ORCH-07, GRP-03]

coverage:
  - id: D1
    description: "rmcp MCP server embedded in Tauri tokio runtime, sharing Arc<PtyManager>, responding on ephemeral 127.0.0.1:PORT"
    requirement: ORCH-02
    verification:
      - kind: other
        ref: "cargo build — compiles without error"
        status: pass
    human_judgment: true
    rationale: "Live handshake test requires running the app with a display (Hyprland/Wayland)"

  - id: D2
    description: ".mcp.json written with type=http after MCP server health-check, before claude parent starts (D-02 ordering)"
    requirement: ORCH-02
    verification:
      - kind: other
        ref: "cargo build + npm run build — pass; D-02 ordering verified by code review (create_group awaited before addTerminalNode)"
        status: pass
    human_judgment: true
    rationale: "Live verification requires creating a group and confirming claude lists spawn_agent tool"

  - id: D3
    description: "spawn_agent creates child TerminalNode inside parent GroupFrame with label + parent→child directed edge"
    requirement: ORCH-03
    verification:
      - kind: other
        ref: "tsc --noEmit + npm run build — pass; addChildNode places node with parentId=groupId, edge source=parentNodeId"
        status: pass
    human_judgment: true
    rationale: "Visual canvas verification requires running GUI with claude parent calling spawn_agent"

  - id: D4
    description: "Blocking spawn_agent returns child stdout to parent; child runs claude -p <task> --output-format text"
    requirement: ORCH-03
    verification:
      - kind: other
        ref: "cargo build passes; run_in_pty_blocking accumulates all PTY output and returns it"
        status: pass
    human_judgment: true
    rationale: "Live round-trip test requires claude CLI and Hyprland display"

  - id: D5
    description: "3 concurrent spawn_agent calls from same parent create 3 isolated child tasks (each in own tokio spawn_blocking thread)"
    requirement: ORCH-07
    verification:
      - kind: other
        ref: "cargo build passes; rmcp StreamableHttpService handles concurrent connections in separate tokio tasks by design"
        status: pass
    human_judgment: true
    rationale: "Concurrency test requires running app and parent claude issuing 3 parallel spawn_agent calls"

  - id: D6
    description: "Child TerminalNode appears inside parent GroupFrame (parentId=groupId, extent=parent), not at canvas root"
    requirement: GRP-03
    verification:
      - kind: other
        ref: "tsc --noEmit pass; addChildNode sets parentId=groupId + extent=parent"
        status: pass
    human_judgment: true
    rationale: "Visual verification requires GUI — parentId constraint enforces containment at ReactFlow level"

duration: 25min
completed: 2026-08-05
status: complete
---

# Phase 4: Orquestração MCP Integrada Summary

**rmcp MCP server embedded in Tauri tokio runtime; spawn_agent creates child TerminalNodes in radial fan inside parent GroupFrame with D-02 .mcp.json ordering and explicit depth tracking**

## Performance

- **Duration:** ~25 min (resumed from interrupted prior run)
- **Started:** 2026-08-05T13:09:00Z
- **Completed:** 2026-08-05T13:26:00Z
- **Tasks:** 4 (Task 1 pre-committed; Tasks 2-4 completed this run)
- **Files modified:** 13

## Accomplishments

- Embedded rmcp Streamable HTTP MCP server in Tauri tokio runtime on ephemeral port, sharing `Arc<PtyManager>` with Tauri commands
- `create_group` Tauri command writes `.mcp.json` (type=http) only after health-check — D-02 ordering guaranteed by Toolbar awaiting the command before mounting the TerminalNode
- `spawn_agent` MCP tool emits `node_created` Tauri event before blocking, canvas listener adds child `TerminalNode` inside the parent `GroupFrame` with directed animated edge
- `layout.ts` implements radial fan positioning (FAN_RADIUS=380px, 144° arc) for child nodes around parent
- `pty_spawn` gains `env` param — TURBO_GROUP_ID and TURBO_MCP_DEPTH=0 injected into parent claude process from Toolbar
- Concurrent spawn_agent: each MCP call runs in independent tokio task + `spawn_blocking` thread — no serialization

## Task Commits

1. **Task 1: Embed MCP server** — `1ca18d9` (feat) — *pre-existing from prior interrupted run*
2. **Task 2: Frontend wiring** — `732f763` (feat) — Canvas.tsx, store.ts, layout.ts, Toolbar.tsx, Cargo.lock
3. **Task 3: create_group/spawn_agent integration** — `dd70a24` (feat) — lib.rs, TerminalNode.tsx, Toolbar.tsx, store.ts, usePty.ts

## Files Created/Modified

- `app/src-tauri/src/mcp/mod.rs` — MCP module entry (re-exports start/McpState)
- `app/src-tauri/src/mcp/server.rs` — SpawnServer rmcp handler, NodeCreatedPayload, start()
- `app/src-tauri/src/mcp/spawn_agent.rs` — run_in_pty_blocking (spawn_blocking, portable-pty)
- `app/src-tauri/src/groups.rs` — GroupRegistry: register() writes .mcp.json with group_id query param
- `app/src-tauri/src/lib.rs` — create_group (mcp.json only), pty_spawn +env param, McpState wiring
- `app/src/canvas/layout.ts` — childPosition() radial fan algorithm
- `app/src/canvas/store.ts` — addChildNode (ptyId=null for child nodes), addTerminalNode +env, TerminalNodeData +env field
- `app/src/canvas/Canvas.tsx` — node_created listener → addChildNode
- `app/src/canvas/Toolbar.tsx` — await create_group then addTerminalNode with env vars (D-02 ordering)
- `app/src/canvas/usePty.ts` — env param forwarded to pty_spawn; existingPtyId path retained
- `app/src/canvas/TerminalNode.tsx` — passes data.env to usePty

## Decisions Made

- **create_group writes .mcp.json only**: Avoids dual-channel complexity; usePty spawns claude AFTER create_group resolves. D-02 ordering guaranteed at Toolbar level (await before addTerminalNode).
- **env param on pty_spawn**: Cleaner than a separate spawn path; allows TURBO_GROUP_ID/DEPTH to reach the parent claude from frontend node data.
- **child nodes ptyId=null**: Child claude processes run inside MCP handler's `run_in_pty_blocking` (not registered in PtyManager). Output returns to parent via MCP return value; xterm not needed for child display nodes.
- **existingPtyId retained in usePty**: Future use case — attach xterm to a pre-running PTY session.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed duplicate-spawn: create_group + usePty both spawned claude**
- **Found during:** Task 3 (integration review)
- **Issue:** Original design had create_group spawn claude AND usePty auto-spawn on mount — two claude processes per group.
- **Fix:** Simplified create_group to write .mcp.json only (no PTY spawn). Toolbar awaits create_group, then addTerminalNode. usePty is the sole claude spawner, using env vars for group context.
- **Files modified:** lib.rs, Toolbar.tsx, store.ts, usePty.ts, TerminalNode.tsx
- **Verification:** tsc --noEmit + cargo build both pass; code review confirms single spawn path
- **Committed in:** dd70a24

**2. [Rule 2 - Missing Critical] Added env param to pty_spawn for group context injection**
- **Found during:** Task 3 (fixing duplicate-spawn required env vars for TURBO_GROUP_ID)
- **Issue:** pty_spawn had no env injection — parent claude couldn't receive its group_id for MCP routing
- **Fix:** Added `env: Option<Vec<[String; 2]>>` to pty_spawn Rust command; TerminalNodeData gains env field; usePty passes it to pty_spawn.
- **Files modified:** lib.rs, store.ts, usePty.ts
- **Verification:** cargo build passes; TypeScript compiles
- **Committed in:** dd70a24

**3. [Rule 1 - Bug] Fixed child node ptyId: UUID string → NaN when coerced to number**
- **Found during:** Task 3 (addChildNode review)
- **Issue:** addChildNode stored `Number(childPtyId)` where childPtyId is a UUID string → NaN, causing usePty to try attaching to NaN PTY id
- **Fix:** Store ptyId=null for child nodes; child display nodes don't need interactive PTY
- **Files modified:** store.ts
- **Verification:** TypeScript compiles; no NaN PTY id in child nodes
- **Committed in:** dd70a24

---

**Total deviations:** 3 auto-fixed (2 Rule 1 bugs, 1 Rule 2 missing critical)
**Impact on plan:** All fixes necessary for correctness. No scope creep. Architecture simplified vs original plan.

## Known Stubs

None — all data paths are wired. Child nodes display label from `spawn_agent` call; output returns to parent via MCP return value (by design, not a stub).

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: command_injection | mcp/server.rs | spawn_agent accepts `task` string from parent claude and passes it as CLI arg to `claude -p`. Trust boundary: parent claude is local, started by the user — acceptable for personal tool. |
| threat_flag: localhost_only | groups.rs | .mcp.json points to 127.0.0.1 only — no remote access possible by design. |

## Human Verification Required

The following require a running app with Hyprland/Wayland display and `claude` CLI on PATH:

1. **Live MCP handshake**: Boot app → confirm MCP log line `"MCP Streamable HTTP server listening on http://127.0.0.1:PORT/mcp"`
2. **spawn_agent tool visible**: Create a group → in parent claude terminal, confirm `claude` lists `spawn_agent` tool from `.mcp.json`
3. **Child node appears in canvas**: Parent claude calls `spawn_agent(task, label, group_id, parent_pty_id)` → child TerminalNode appears in radial fan with directed edge inside GroupFrame
4. **Blocking return**: spawn_agent call completes and returns child stdout to parent
5. **Concurrency**: 3 concurrent spawn_agent calls → 3 child nodes, isolated outputs

## Next Phase Readiness

Phase 4 is the final planned phase. The full MCP orchestration loop is implemented:
- MCP server embedded and serving spawn_agent tool
- .mcp.json written with correct D-02 ordering
- Canvas wired to react to node_created events
- All cargo build + tsc + npm run build green

Remaining: live GUI verification (human-needed, requires Hyprland display + claude CLI).

---
*Phase: 04-orquestra-o-mcp-integrada*
*Completed: 2026-08-05*
