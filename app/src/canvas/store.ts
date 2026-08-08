/**
 * Canvas store — Zustand store for nodes, edges, groups, and per-group cwd.
 *
 * Uses @xyflow/react applyNodeChanges / applyEdgeChanges helpers so the
 * ReactFlow instance stays in sync.
 *
 * Design contract: 03-UI-SPEC.md
 * - GroupFrame default size: 800×600px
 * - TerminalNode default size: 480×280px
 * - Inner padding from group frame to child nodes: 32px (--xl)
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import {
  Node,
  Edge,
  Connection,
  NodeChange,
  EdgeChange,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  MarkerType,
} from "@xyflow/react";
import { childPosition, CHILD_NODE_WIDTH, CHILD_NODE_HEIGHT } from "./layout";

export type NodeStatus = "running" | "ok" | "error";

/** Extra data carried by a TerminalNode */
export interface TerminalNodeData extends Record<string, unknown> {
  label: string;
  ptyId: number | null;
  status: NodeStatus;
  cwd?: string;
  /** Command to launch in the PTY. Defaults to shell if omitted. */
  command?: string;
  args?: string[];
  /** Backend token (e.g. "codex", "opus", "fable") — the STABLE identity used to
   *  RE-COMPOSE the launch command at restore time (fresh port + resume). */
  agent?: string;
  /** Agent role / system prompt — persisted so restore can recompose without
   *  depending on the (port-stale) baked args. */
  role?: string;
  /** Extra env vars to inject into the PTY process (e.g. TURBO_GROUP_ID). */
  env?: [string, string][];
  /** Accent color of the agent this terminal runs (from its AgentDef). */
  color?: string;
  /** Pinned Claude session id — used to read this terminal's token/cost usage. */
  sessionId?: string;
  /** Absolute path of the git worktree this terminal runs inside. */
  worktree?: string;
}

/** Token + estimated cost usage for a terminal (from the Rust session_usage cmd). */
export interface UsageReport {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  total_tokens: number;
  cost_usd: number;
  found: boolean;
}

/** Add two usage reports field-by-field (used to accumulate closed terminals). */
function addUsage(a: UsageReport, b: UsageReport): UsageReport {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens:
      a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    cost_usd: a.cost_usd + b.cost_usd,
    found: a.found || b.found,
  };
}

/** A saved agent belonging to a project (group). Persists until deleted; a
 *  terminal is only opened on demand via its "Abrir terminal" button. */
export interface AgentDef {
  id: string;
  name: string;
  model: string;
  prompt: string;
  color: string;
}

/** One git worktree listed for a group. Mirrors `Worktree` from worktrees.rs. */
export interface Worktree {
  path: string;
  branch: string;
  is_root: boolean;
}

/** Extra data carried by a GroupFrame node */
export interface GroupNodeData extends Record<string, unknown> {
  label: string;
  cwd: string;
  /** Saved agents of this project (shown in the right side menu). */
  agents?: AgentDef[];
  /** Detected git worktrees for this group (populated by GroupFrame on mount). */
  worktrees?: Worktree[];
  /** Path of the currently selected worktree raia; absent = repo root. */
  activeWorktree?: string;
  /** If set, this group IS a worktree subgroup of the given repo group id. */
  worktreeOf?: string;
  /** Branch name of the worktree this subgroup represents (when worktreeOf set). */
  worktreeBranch?: string;
  /** Cumulative usage of terminals that were CLOSED — persisted so the group's
   *  running total never drops when a terminal is removed. The live group total
   *  is this plus the currently-open terminals' usage. */
  usageTotal?: UsageReport;
}

/** Extra data carried by a ViewerNode (file content viewer). */
export interface ViewerNodeData extends Record<string, unknown> {
  label: string;
  groupId: string;
  filePath: string;
  cwd: string;
}

export type AppNode = Node<TerminalNodeData | GroupNodeData | ViewerNodeData>;

/** Agent backends selectable per agent. `value` is the token sent to Rust
 *  (create_group / spawn_agent): "codex", or a Claude model alias. */
export const AGENT_OPTIONS: { value: string; label: string }[] = [
  { value: "fable", label: "Fable 5" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
  { value: "codex", label: "Codex (padrão)" },
];

/** Accent colors assignable to agents. New agents pick the next unused one. */
export const AGENT_COLORS: string[] = [
  "#6ea8fe", // blue
  "#63e6be", // teal
  "#ffa94d", // orange
  "#da77f2", // purple
  "#ff8787", // red
  "#ffd43b", // yellow
  "#69db7c", // green
  "#4dabf7", // sky
];

/** Pick the first palette color not already used by the group's agents. */
export function nextAgentColor(used: string[]): string {
  return AGENT_COLORS.find((c) => !used.includes(c)) ?? AGENT_COLORS[used.length % AGENT_COLORS.length];
}

/** A ready-made agent: role name + backend model + starter prompt. Clicking a
 *  preset in the create-agent modal pre-fills the form (still editable). */
export interface AgentPreset {
  name: string;
  model: string;
  prompt: string;
}

export const AGENT_PRESETS: AgentPreset[] = [
  {
    name: "Orquestrador",
    model: "fable",
    prompt:
      "Você é o orquestrador da equipe. Planeje o trabalho e delegue subtarefas aos agentes usando a tool turbo spawn_agent (escolhendo o modelo certo por tarefa). Consolide os resultados.",
  },
  {
    name: "Backend",
    model: "opus",
    prompt:
      "Você é o agente de backend: APIs, banco de dados, lógica de servidor e integrações. Escreva código robusto e testável.",
  },
  {
    name: "Frontend",
    model: "sonnet",
    prompt:
      "Você é o agente de frontend: UI, componentes, estado e estilo. Priorize acessibilidade e uma interface limpa.",
  },
  {
    name: "Segurança",
    model: "codex",
    prompt:
      "Você é o agente de segurança: revise o código em busca de vulnerabilidades (OWASP), secrets expostos e validação de entrada. Reporte riscos com severidade.",
  },
  {
    name: "Testes",
    model: "haiku",
    prompt:
      "Você é o agente de testes: escreva e rode testes unitários/integração, cubra casos de borda e garanta a suíte verde.",
  },
];

interface CanvasState {
  nodes: AppNode[];
  edges: Edge[];
  /** Live token/cost usage per terminal node id (updated by TerminalNode polls). */
  usageByNode: Record<string, UsageReport>;
  /** Store/replace the usage report for a terminal node. */
  setNodeUsage: (nodeId: string, report: UsageReport) => void;
  groupCounter: number;

  // @xyflow handlers
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;

  // Group management
  addGroup: (cwd: string) => string; // returns group node id
  addTerminalNode: (groupId: string, ptyId: number | null, cwd?: string, command?: string, env?: [string, string][], args?: string[], color?: string, sessionId?: string, worktree?: string, agent?: string, role?: string) => string;
  /** Replace a terminal's launch command+args (used by restore to swap in the
   *  freshly-composed `resume` command before the PTY spawns). */
  setTerminalSpawn: (nodeId: string, command: string, args: string[]) => void;
  /** Cache detected git worktrees for a group (populated by GroupFrame on mount). */
  setGroupWorktrees: (groupId: string, list: Worktree[]) => void;
  /** Set the active worktree raia for a group. */
  setActiveWorktree: (groupId: string, path: string) => void;
  /** Open (or focus) a sibling group frame dedicated to `worktree` — its cwd is
   *  the worktree path, so create_group writes .mcp.json there and its terminals
   *  run in that worktree. Deduped by cwd. Returns the subgroup node id. */
  openWorktreeGroup: (parentGroupId: string, worktree: Worktree) => string;
  /** Add a child TerminalNode spawned by a parent agent (MCP spawn_agent call).
   *  Places it in a radial fan around the parent, adds a parent→child edge.
   *  Returns the new child node id. */
  addChildNode: (params: {
    groupId: string;
    parentNodeId: string;
    label: string;
    childPtyId: string | null;
  }) => string;
  removeNode: (nodeId: string) => void;
  /** Open (or focus) a ViewerNode for a file inside a group. Deduped by groupId+filePath.
   *  Returns the viewer node id. */
  addViewerNode: (groupId: string, filePath: string, cwd: string) => string;
  /** Save a new agent definition into a project (persists until removed). */
  addAgentDef: (groupId: string, def: AgentDef) => void;
  /** Update a saved agent's definition (name, model, prompt, color) in place. */
  updateAgentDef: (groupId: string, def: AgentDef) => void;
  /** Remove a saved agent from a project. */
  removeAgentDef: (groupId: string, agentId: string) => void;
  updateNodeStatus: (nodeId: string, status: NodeStatus) => void;
  updateNodeLabel: (nodeId: string, label: string) => void;
  setPtyId: (nodeId: string, ptyId: number) => void;
  /** Re-anchor all groups to fully contain their children (call on resize-end). */
  normalizeGroups: () => void;
  /** Push a group out of any other group it overlaps (call on group drag-stop). */
  resolveGroupOverlap: (groupId: string) => void;
  /** Reposition all groups into a neat aligned grid (Auto-grid / Ctrl+G). */
  autoGridGroups: () => void;
  /** Lay out a group's child nodes (terminals/viewers) in a uniform grid with no
   *  overlap (Alt+G). Pass a groupId to target one group, or omit to grid all
   *  groups. Grows each group to fit and separates any groups that now collide. */
  autoGridTerminals: (groupId?: string) => void;
}

// ── Group auto-sizing ─────────────────────────────────────────────────────────
const GROUP_PAD = 32; // breathing room around child nodes
const GROUP_TOP = 60; // label bar (28px) + padding — children start below it
// Right gutter reserved inside every group for the docked "Agentes" side menu.
const SIDEBAR_RESERVE = 234; // panel width (210) + gaps
const MIN_GROUP_W = 640;
const MIN_GROUP_H = 440;

/** Best-effort current rendered size of a node (measured > explicit > style > default). */
function nodeSize(n: AppNode): { w: number; h: number } {
  const measured = (n as { measured?: { width?: number; height?: number } }).measured;
  const wTop = (n as { width?: number }).width;
  const hTop = (n as { height?: number }).height;
  const styleW = typeof n.style?.width === "number" ? n.style.width : undefined;
  const styleH = typeof n.style?.height === "number" ? n.style.height : undefined;
  return {
    w: measured?.width ?? wTop ?? styleW ?? 780,
    h: measured?.height ?? hTop ?? styleH ?? 540,
  };
}

/**
 * Grow every GroupFrame so it contains all of its child nodes (bounding box +
 * padding). Children are parent-relative, so a child at (x,y) with size (w,h)
 * needs the group to be at least x+w wide and y+h tall. Runs on any node change
 * (add / move / resize) so the group tracks the terminals inside it.
 */
/** Grow-only fit (right/bottom). Safe to run LIVE during a drag/resize — it never
 *  moves the group origin, so it can't feed back into the NodeResizer. */
function fitGroups(nodes: AppNode[]): AppNode[] {
  return nodes.map((n) => {
    if (n.type !== "group") return n;
    const children = nodes.filter((c) => c.parentId === n.id);
    if (children.length === 0) return n;
    let maxRight = 0;
    let maxBottom = 0;
    for (const c of children) {
      const { w, h } = nodeSize(c);
      maxRight = Math.max(maxRight, c.position.x + w);
      maxBottom = Math.max(maxBottom, c.position.y + h);
    }
    const width = Math.max(MIN_GROUP_W, Math.round(maxRight + GROUP_PAD + SIDEBAR_RESERVE));
    const height = Math.max(MIN_GROUP_H, Math.round(maxBottom + GROUP_PAD));
    const cur = n.style ?? {};
    if (cur.width === width && cur.height === height) return n;
    return { ...n, style: { ...cur, width, height } };
  });
}

/** Full re-anchor (all 4 sides): pulls left/top-overflowing children back inside
 *  and moves the group origin to match. Run ONCE on resize-end — running it live
 *  fights the NodeResizer and makes the group fly away. */
function reanchorGroups(nodes: AppNode[]): AppNode[] {
  const groups = nodes.filter((n) => n.type === "group");
  if (groups.length === 0) return nodes;

  // Per-group adjustment: shift (dx,dy) to pull left/top-overflowing children back
  // inside, plus the new width/height that bounds all children with padding.
  const adj = new Map<
    string,
    { dx: number; dy: number; width: number; height: number }
  >();
  for (const g of groups) {
    const children = nodes.filter((c) => c.parentId === g.id);
    if (children.length === 0) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxRight = -Infinity;
    let maxBottom = -Infinity;
    for (const c of children) {
      const { w, h } = nodeSize(c);
      minX = Math.min(minX, c.position.x);
      minY = Math.min(minY, c.position.y);
      maxRight = Math.max(maxRight, c.position.x + w);
      maxBottom = Math.max(maxBottom, c.position.y + h);
    }
    // Enforce EXACTLY GROUP_PAD/GROUP_TOP margin on the left/top. Positive shifts
    // expand the frame to cover overflow; negative shifts contract it when the
    // child moved inward — so shrinking a terminal shrinks the group back too.
    const dx = Math.round(GROUP_PAD - minX);
    const dy = Math.round(GROUP_TOP - minY);
    const width = Math.max(MIN_GROUP_W, Math.round(maxRight + dx + GROUP_PAD + SIDEBAR_RESERVE));
    const height = Math.max(MIN_GROUP_H, Math.round(maxBottom + dy + GROUP_PAD));
    adj.set(g.id, { dx, dy, width, height });
  }

  if (adj.size === 0) return nodes;

  return nodes.map((n) => {
    if (n.type === "group") {
      const a = adj.get(n.id);
      if (!a) return n;
      const cur = n.style ?? {};
      const posChanged = a.dx !== 0 || a.dy !== 0;
      const sizeChanged = cur.width !== a.width || cur.height !== a.height;
      if (!posChanged && !sizeChanged) return n;
      // Move the group origin left/up by (dx,dy) so children shifted right/down
      // by the same amount stay visually put — the frame simply grows to cover them.
      return {
        ...n,
        position: posChanged
          ? { x: n.position.x - a.dx, y: n.position.y - a.dy }
          : n.position,
        style: { ...cur, width: a.width, height: a.height },
      };
    }
    // Shift children of a re-anchored group to keep them inside the frame.
    if (n.parentId) {
      const a = adj.get(n.parentId);
      if (a && (a.dx !== 0 || a.dy !== 0)) {
        return { ...n, position: { x: n.position.x + a.dx, y: n.position.y + a.dy } };
      }
    }
    return n;
  });
}

/** Bounding rect of a group node (falls back to the default group size). */
function groupRect(n: AppNode): { x: number; y: number; w: number; h: number } {
  const w = typeof n.style?.width === "number" ? n.style.width : 1120;
  const h = typeof n.style?.height === "number" ? n.style.height : 780;
  return { x: n.position.x, y: n.position.y, w, h };
}

const GROUP_GAP = 24; // minimum gap kept between two groups

/** Push `groupId` out of any other group it overlaps, along the least-overlap
 *  axis, until it collides with none (or a safety cap is reached). Groups own
 *  their children (parent-relative), so moving the group moves its terminals too. */
function pushGroupOut(nodes: AppNode[], groupId: string): AppNode[] {
  const groups = nodes.filter((n) => n.type === "group");
  const moved = groups.find((g) => g.id === groupId);
  if (!moved) return nodes;
  let { x, y } = moved.position;
  const { w, h } = groupRect(moved);
  for (let iter = 0; iter < 24; iter++) {
    let collided = false;
    for (const o of groups) {
      if (o.id === groupId) continue;
      const r = groupRect(o);
      const overlapX = Math.min(x + w, r.x + r.w) - Math.max(x, r.x);
      const overlapY = Math.min(y + h, r.y + r.h) - Math.max(y, r.y);
      if (overlapX > 0 && overlapY > 0) {
        if (overlapX < overlapY) {
          x += x + w / 2 < r.x + r.w / 2 ? -(overlapX + GROUP_GAP) : overlapX + GROUP_GAP;
        } else {
          y += y + h / 2 < r.y + r.h / 2 ? -(overlapY + GROUP_GAP) : overlapY + GROUP_GAP;
        }
        collided = true;
      }
    }
    if (!collided) break;
  }
  if (x === moved.position.x && y === moved.position.y) return nodes;
  return nodes.map((n) => (n.id === groupId ? { ...n, position: { x, y } } : n));
}

/** Separate ALL overlapping groups (e.g. after a terminal grew its group over a
 *  neighbour). Repeatedly pushes each group out of the others until stable. */
function separateGroups(nodes: AppNode[]): AppNode[] {
  const ids = nodes.filter((n) => n.type === "group").map((g) => g.id);
  if (ids.length < 2) return nodes;
  let result = nodes;
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (const id of ids) {
      const before = result;
      result = pushGroupOut(result, id);
      if (result !== before) moved = true;
    }
    if (!moved) break;
  }
  return result;
}

export const useCanvasStore = create<CanvasState>()(
  persist(
    (set, get) => ({
  nodes: [],
  edges: [],
  usageByNode: {},
  setNodeUsage: (nodeId: string, report: UsageReport): void =>
    set((state) => ({ usageByNode: { ...state.usageByNode, [nodeId]: report } })),
  groupCounter: 0,

  onNodesChange: (changes) => {
    // Apply the change, then re-fit every group to its (possibly moved/resized) children.
    const next = applyNodeChanges(changes, get().nodes) as AppNode[];
    set({ nodes: fitGroups(next) });
  },

  onEdgesChange: (changes) => {
    set({ edges: applyEdgeChanges(changes, get().edges) });
  },

  onConnect: (connection) => {
    set({ edges: addEdge(connection, get().edges) });
  },

  addGroup: (cwd: string): string => {
    const { groupCounter, nodes } = get();
    const n = groupCounter + 1;
    const groupId = `group-${Date.now()}`;
    const label = `Grupo ${n}`;

    // Position new groups in a cascade pattern
    const x = 80 + (n - 1) * 60;
    const y = 80 + (n - 1) * 60;

    const groupNode: AppNode = {
      id: groupId,
      type: "group",
      position: { x, y },
      data: { label, cwd } as GroupNodeData,
      style: {
        width: 1120,
        height: 780,
      },
    };

    set({
      nodes: pushGroupOut([...nodes, groupNode], groupId),
      groupCounter: n,
    });

    return groupId;
  },

  openWorktreeGroup: (parentGroupId: string, worktree: Worktree): string => {
    const { nodes } = get();
    // Dedup: a group already dedicated to this worktree path — just focus it.
    const existing = nodes.find(
      (n) => n.type === "group" && (n.data as GroupNodeData).cwd === worktree.path
    );
    if (existing) return existing.id;

    const parent = nodes.find((n) => n.id === parentGroupId);
    const parentData = parent?.data as GroupNodeData | undefined;
    const baseLabel = parentData?.label ?? "Grupo";
    const psize = parent ? nodeSize(parent) : { w: 1120, h: 780 };
    const px = parent?.position.x ?? 80;
    const py = parent?.position.y ?? 80;

    const groupId = `group-${Date.now()}`;
    const groupNode: AppNode = {
      id: groupId,
      type: "group",
      // Place to the right of the repo group; pushGroupOut resolves overlaps.
      position: { x: px + psize.w + 80, y: py },
      data: {
        label: `${baseLabel} · ${worktree.branch}`,
        cwd: worktree.path,
        worktreeOf: parentGroupId,
        worktreeBranch: worktree.branch,
        // Inherit the repo group's saved agents so the same team is openable here.
        agents: parentData?.agents ? [...parentData.agents] : undefined,
      } as GroupNodeData,
      style: { width: 1120, height: 780 },
    };

    set({ nodes: pushGroupOut([...nodes, groupNode], groupId) });
    return groupId;
  },

  addTerminalNode: (groupId: string, ptyId: number | null, cwd?: string, command?: string, env?: [string, string][], args?: string[], color?: string, sessionId?: string, worktree?: string, agent?: string, role?: string): string => {
    const { nodes } = get();
    const nodeId = `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const parentNode = nodes.find((n) => n.id === groupId);
    const existingChildren = nodes.filter((n) => n.parentId === groupId);

    // Place inside the group with 32px inner padding (--xl)
    const innerPad = 32;
    const labelBarH = 28;
    // Single-column vertical stack so the larger 780×540 terminals never overlap.
    const row = existingChildren.length;
    const terminalX = innerPad;
    const terminalY = labelBarH + innerPad + row * (540 + innerPad);

    const terminalLabel =
      parentNode
        ? `${(parentNode.data as GroupNodeData).label} · ${existingChildren.length + 1}`
        : "Terminal";

    const terminalNode: AppNode = {
      id: nodeId,
      type: "terminal",
      parentId: groupId,
      position: { x: terminalX, y: terminalY },
      data: {
        label: terminalLabel,
        ptyId,
        status: "running" as NodeStatus,
        cwd,
        command,
        args,
        env,
        color,
        sessionId,
        worktree,
        agent,
        role,
      } as TerminalNodeData,
      style: {
        width: 780,
        height: 540,
      },
    };

    set({ nodes: fitGroups([...nodes, terminalNode]) });
    return nodeId;
  },

  setGroupWorktrees: (groupId: string, list: Worktree[]): void => {
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== groupId) return n;
        const data = n.data as GroupNodeData;
        return { ...n, data: { ...data, worktrees: list } };
      }),
    }));
  },

  setActiveWorktree: (groupId: string, path: string): void => {
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== groupId) return n;
        const data = n.data as GroupNodeData;
        return { ...n, data: { ...data, activeWorktree: path } };
      }),
    }));
  },

  addAgentDef: (groupId: string, def: AgentDef): void => {
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== groupId) return n;
        const data = n.data as GroupNodeData;
        return { ...n, data: { ...data, agents: [...(data.agents ?? []), def] } };
      }),
    }));
  },

  updateAgentDef: (groupId: string, def: AgentDef): void => {
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== groupId) return n;
        const data = n.data as GroupNodeData;
        return {
          ...n,
          data: {
            ...data,
            agents: (data.agents ?? []).map((a) => (a.id === def.id ? def : a)),
          },
        };
      }),
    }));
  },

  removeAgentDef: (groupId: string, agentId: string): void => {
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== groupId) return n;
        const data = n.data as GroupNodeData;
        return {
          ...n,
          data: { ...data, agents: (data.agents ?? []).filter((a) => a.id !== agentId) },
        };
      }),
    }));
  },

  addChildNode: ({ groupId, parentNodeId, label, childPtyId: _childPtyId }) => {
    const { nodes, edges } = get();
    const nodeId = `terminal-child-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // Find the parent node to compute radial position relative to it.
    const parentNode = nodes.find((n) => n.id === parentNodeId);
    const parentPos = parentNode?.position ?? { x: 100, y: 100 };

    // Count existing children of this parent to spread the fan correctly.
    // We include the one being added (+1).
    const existingSiblings = nodes.filter(
      (n) => n.parentId === groupId && n.id !== parentNodeId &&
        edges.some((e) => e.source === parentNodeId && e.target === n.id)
    );
    const childIndex = existingSiblings.length;
    const totalChildren = existingSiblings.length + 1;

    const pos = childPosition(parentPos, childIndex, totalChildren);

    const childNode: AppNode = {
      id: nodeId,
      type: "terminal",
      parentId: groupId,
      position: pos,
      data: {
        label,
        // childPtyId is a UUID string from the MCP handler — not a PtyManager id.
        // Child nodes are read-only display nodes (output returns to the parent via
        // MCP response, not xterm). Keep ptyId null so usePty doesn't try to attach.
        ptyId: null,
        status: "running" as NodeStatus,
      } as TerminalNodeData,
      style: {
        width: CHILD_NODE_WIDTH,
        height: CHILD_NODE_HEIGHT,
      },
    };

    // Parent→child directed edge
    const edge: Edge = {
      id: `edge-${parentNodeId}-${nodeId}`,
      source: parentNodeId,
      target: nodeId,
      type: "smoothstep",
      animated: true,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: "var(--brand-a)",
      },
      style: {
        stroke: "var(--brand-a)",
        strokeWidth: 2,
      },
    };

    set({
      nodes: fitGroups([...nodes, childNode]),
      edges: [...edges, edge],
    });

    return nodeId;
  },

  removeNode: (nodeId: string) => {
    const { nodes, edges, usageByNode } = get();
    // Remove the node and any nodes that are children of it
    const toRemove = new Set<string>([nodeId]);
    for (const n of nodes) {
      if (n.parentId && toRemove.has(n.parentId)) {
        toRemove.add(n.id);
      }
    }
    // Fold each closed terminal's last-known usage into its parent group's
    // persisted cumulative total, so the group's number stays fixed instead of
    // dropping when the terminal is removed. Skip groups that are themselves
    // being removed (closing the whole group discards its total).
    const fold = new Map<string, UsageReport>();
    for (const n of nodes) {
      if (!toRemove.has(n.id) || n.type !== "terminal" || !n.parentId) continue;
      if (toRemove.has(n.parentId)) continue;
      const u = usageByNode[n.id];
      if (!u || !u.found) continue;
      const acc = fold.get(n.parentId);
      fold.set(n.parentId, acc ? addUsage(acc, u) : u);
    }
    const nextNodes = nodes
      .filter((n) => !toRemove.has(n.id))
      .map((n) => {
        const add = fold.get(n.id);
        if (!add || n.type !== "group") return n;
        const data = n.data as GroupNodeData;
        return {
          ...n,
          data: {
            ...data,
            usageTotal: data.usageTotal ? addUsage(data.usageTotal, add) : add,
          },
        };
      });
    set({
      nodes: nextNodes,
      edges: edges.filter(
        (e) => !toRemove.has(e.source) && !toRemove.has(e.target)
      ),
    });
  },

  addViewerNode: (groupId: string, filePath: string, cwd: string): string => {
    const { nodes } = get();

    // Dedup: if a viewer for this group+file already exists, return its id.
    const existing = nodes.find(
      (n) =>
        n.type === "viewer" &&
        (n.data as ViewerNodeData).groupId === groupId &&
        (n.data as ViewerNodeData).filePath === filePath
    );
    if (existing) return existing.id;

    const nodeId = `viewer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // Positioning: to the right of terminals, stacked vertically per viewer count.
    const innerPad = 32;
    const labelBarH = 28;
    const viewerWidth = 520;
    const viewerHeight = 540;
    const viewerX = innerPad + 800; // to the right of the 780-wide terminal column

    const existingViewers = nodes.filter(
      (n) => n.type === "viewer" && n.parentId === groupId
    );
    const viewerY =
      labelBarH + innerPad + existingViewers.length * (viewerHeight + innerPad);

    // Extract basename from filePath (works for both / and \ separators).
    const label = filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;

    const viewerNode: AppNode = {
      id: nodeId,
      type: "viewer",
      parentId: groupId,
      position: { x: viewerX, y: viewerY },
      data: { label, groupId, filePath, cwd } as ViewerNodeData,
      style: {
        width: viewerWidth,
        height: viewerHeight,
      },
    };

    set({ nodes: fitGroups([...nodes, viewerNode]) });
    return nodeId;
  },

  updateNodeStatus: (nodeId: string, status: NodeStatus) => {
    set({
      nodes: get().nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, status } }
          : n
      ),
    });
  },

  updateNodeLabel: (nodeId: string, label: string) => {
    set({
      nodes: get().nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, label } }
          : n
      ),
    });
  },

  setPtyId: (nodeId: string, ptyId: number) => {
    set({
      nodes: get().nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, ptyId } }
          : n
      ),
    });
  },

  setTerminalSpawn: (nodeId: string, command: string, args: string[]) => {
    set({
      nodes: get().nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, command, args } }
          : n
      ),
    });
  },

  normalizeGroups: () => {
    set({ nodes: separateGroups(reanchorGroups(get().nodes)) });
  },

  resolveGroupOverlap: (groupId: string) => {
    set({ nodes: pushGroupOut(get().nodes, groupId) });
  },

  autoGridGroups: () => {
    const nodes = get().nodes;
    const groups = nodes.filter((n) => n.type === "group");
    if (groups.length === 0) return;
    const gap = 48;
    const originX = 40;
    const originY = 40;
    // Uniform cells sized to the largest group → a clean, aligned grid.
    const cellW = Math.max(...groups.map((g) => groupRect(g).w));
    const cellH = Math.max(...groups.map((g) => groupRect(g).h));
    const cols = Math.max(1, Math.ceil(Math.sqrt(groups.length)));
    const posMap = new Map<string, { x: number; y: number }>();
    groups.forEach((g, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      posMap.set(g.id, {
        x: originX + col * (cellW + gap),
        y: originY + row * (cellH + gap),
      });
    });
    set({
      nodes: nodes.map((n) =>
        posMap.has(n.id) ? { ...n, position: posMap.get(n.id)! } : n
      ),
    });
  },

  autoGridTerminals: (groupId?: string) => {
    const nodes = get().nodes;
    const targetGroups = nodes.filter(
      (n) => n.type === "group" && (!groupId || n.id === groupId)
    );
    if (targetGroups.length === 0) return;
    const gap = GROUP_PAD; // 32px breathing room between children
    const posMap = new Map<string, { x: number; y: number }>();
    for (const g of targetGroups) {
      const children = nodes.filter((c) => c.parentId === g.id);
      if (children.length === 0) continue;
      // Stable order: current reading order (top-to-bottom, then left-to-right)
      // so gridding rearranges predictably instead of shuffling terminals.
      const ordered = [...children].sort(
        (a, b) => a.position.y - b.position.y || a.position.x - b.position.x
      );
      // Uniform cells sized to the largest child → guaranteed no overlap even
      // with mixed terminal/viewer sizes.
      const cellW = Math.max(...ordered.map((c) => nodeSize(c).w));
      const cellH = Math.max(...ordered.map((c) => nodeSize(c).h));
      const cols = Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
      ordered.forEach((c, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        posMap.set(c.id, {
          x: GROUP_PAD + col * (cellW + gap),
          y: GROUP_TOP + row * (cellH + gap),
        });
      });
    }
    if (posMap.size === 0) return;
    const moved = nodes.map((n) =>
      posMap.has(n.id) ? { ...n, position: posMap.get(n.id)! } : n
    );
    // Grow each group to contain its re-laid children, then push apart any
    // groups that grew into a neighbour.
    set({ nodes: separateGroups(fitGroups(moved)) });
  },
    }),
    {
      // Session persistence: groups + terminals survive app restarts (localStorage,
      // kept by WebKitGTK across sessions). PTYs die on close, so on restore each
      // terminal re-spawns its command; ephemeral spawn_agent children are dropped.
      name: "turbo-canvas",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ nodes: s.nodes, groupCounter: s.groupCounter }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as {
          nodes?: AppNode[];
          groupCounter?: number;
        };
        const restored = (p.nodes ?? [])
          // Drop ephemeral children created by spawn_agent (one-shot MCP results).
          .filter((n) => !n.id.startsWith("terminal-child-"))
          // Reset runtime-only fields — the PTY is gone; usePty re-spawns on mount.
          .map((n) =>
            n.type === "terminal"
              ? ({
                  ...n,
                  // Drop any legacy parent-extent so restored terminals resize freely.
                  extent: undefined,
                  data: {
                    ...(n.data as TerminalNodeData),
                    ptyId: null,
                    status: "running" as NodeStatus,
                    // command+args are RE-COMPOSED before the canvas mounts (see
                    // prepareRestore in mcp.ts) so the conversation continues with
                    // this session's MCP port — no stale-args replay here.
                  },
                } as AppNode)
              : n
          );
        return {
          ...current,
          nodes: restored,
          edges: [], // parent→child edges reference dropped children
          groupCounter: p.groupCounter ?? 0,
        };
      },
    }
  )
);
