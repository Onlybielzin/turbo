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
}

/** Extra data carried by a GroupFrame node */
export interface GroupNodeData extends Record<string, unknown> {
  label: string;
  cwd: string;
}

export type AppNode = Node<TerminalNodeData | GroupNodeData>;

interface CanvasState {
  nodes: AppNode[];
  edges: Edge[];
  groupCounter: number;

  // @xyflow handlers
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;

  // Group management
  addGroup: (cwd: string) => string; // returns group node id
  addTerminalNode: (groupId: string, ptyId: number | null, cwd?: string, command?: string, env?: [string, string][]) => string;
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
  updateNodeStatus: (nodeId: string, status: NodeStatus) => void;
  updateNodeLabel: (nodeId: string, label: string) => void;
  setPtyId: (nodeId: string, ptyId: number) => void;
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  nodes: [],
  edges: [],
  groupCounter: 0,

  onNodesChange: (changes) => {
    set({ nodes: applyNodeChanges(changes, get().nodes) as AppNode[] });
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
        width: 800,
        height: 600,
      },
    };

    set({
      nodes: [...nodes, groupNode],
      groupCounter: n,
    });

    return groupId;
  },

  addTerminalNode: (groupId: string, ptyId: number | null, cwd?: string, command?: string, env?: [string, string][]): string => {
    const { nodes } = get();
    const nodeId = `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const parentNode = nodes.find((n) => n.id === groupId);
    const existingChildren = nodes.filter((n) => n.parentId === groupId);

    // Place inside the group with 32px inner padding (--xl)
    const innerPad = 32;
    const labelBarH = 28;
    const col = existingChildren.length % 2;
    const row = Math.floor(existingChildren.length / 2);
    const terminalX = innerPad + col * (480 + innerPad);
    const terminalY = labelBarH + innerPad + row * (280 + innerPad);

    const terminalLabel =
      parentNode
        ? `${(parentNode.data as GroupNodeData).label} · ${existingChildren.length + 1}`
        : "Terminal";

    const terminalNode: AppNode = {
      id: nodeId,
      type: "terminal",
      parentId: groupId,
      extent: "parent",
      position: { x: terminalX, y: terminalY },
      data: {
        label: terminalLabel,
        ptyId,
        status: "running" as NodeStatus,
        cwd,
        command,
        env,
      } as TerminalNodeData,
      style: {
        width: 480,
        height: 280,
      },
    };

    set({ nodes: [...nodes, terminalNode] });
    return nodeId;
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
      extent: "parent",
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
      nodes: [...nodes, childNode],
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
}));
