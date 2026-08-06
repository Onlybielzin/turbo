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
  /** Extra env vars to inject into the PTY process (e.g. TURBO_GROUP_ID). */
  env?: [string, string][];
  /** Accent color of the agent this terminal runs (from its AgentDef). */
  color?: string;
  /** Pinned Claude session id — used to read this terminal's token/cost usage. */
  sessionId?: string;
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

/** A saved agent belonging to a project (group). Persists until deleted; a
 *  terminal is only opened on demand via its "Abrir terminal" button. */
export interface AgentDef {
  id: string;
  name: string;
  model: string;
  prompt: string;
  color: string;
}

/** Extra data carried by a GroupFrame node */
export interface GroupNodeData extends Record<string, unknown> {
  label: string;
  cwd: string;
  /** Saved agents of this project (shown in the right side menu). */
  agents?: AgentDef[];
}

export type AppNode = Node<TerminalNodeData | GroupNodeData>;

/** Agent backends selectable per agent. `value` is the token sent to Rust
 *  (create_group / spawn_agent): "codex", or a Claude model alias. */
export const AGENT_OPTIONS: { value: string; label: string }[] = [
  { value: "fable", label: "Fable 5" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
  { value: "codex", label: "Codex" },
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
  addTerminalNode: (groupId: string, ptyId: number | null, cwd?: string, command?: string, env?: [string, string][], args?: string[], color?: string, sessionId?: string) => string;
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
  /** Save a new agent definition into a project (persists until removed). */
  addAgentDef: (groupId: string, def: AgentDef) => void;
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

  addTerminalNode: (groupId: string, ptyId: number | null, cwd?: string, command?: string, env?: [string, string][], args?: string[], color?: string, sessionId?: string): string => {
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
      } as TerminalNodeData,
      style: {
        width: 780,
        height: 540,
      },
    };

    set({ nodes: fitGroups([...nodes, terminalNode]) });
    return nodeId;
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
    const { nodes, edges } = get();
    // Remove the node and any nodes that are children of it
    const toRemove = new Set<string>([nodeId]);
    for (const n of nodes) {
      if (n.parentId && toRemove.has(n.parentId)) {
        toRemove.add(n.id);
      }
    }
    set({
      nodes: nodes.filter((n) => !toRemove.has(n.id)),
      edges: edges.filter(
        (e) => !toRemove.has(e.source) && !toRemove.has(e.target)
      ),
    });
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
