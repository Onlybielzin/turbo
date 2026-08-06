/**
 * Canvas — Infinite pan/zoom canvas (@xyflow/react) that hosts TerminalNodes
 * and GroupFrames. This is the Phase 3 main view, replacing the single terminal
 * in App.tsx.
 *
 * Phase 4: listens for `node_created` Tauri events emitted by the MCP spawn_agent
 * handler, adds child TerminalNodes in a radial fan with parent→child edges.
 *
 * Design contract: 03-UI-SPEC.md
 * - Dot background: 2px dots, 24px gap, colour #2a2622 (--canvas-dot)
 * - Controls: bottom-right, styled to --panel
 * - Toolbar: top-left absolute overlay with "+ Novo grupo" button
 * - Empty state: centred message when no nodes exist
 */
import { useEffect, useState } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  ReactFlowProvider,
  NodeTypes,
  DefaultEdgeOptions,
  MarkerType,
} from "@xyflow/react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import "@xyflow/react/dist/style.css";
import "./canvas.css";
import { useCanvasStore, GroupNodeData, nextAgentColor } from "./store";
import { TerminalNode } from "./TerminalNode";
import { GroupFrame } from "./GroupFrame";
import { ViewerNode } from "./ViewerNode";
import { Toolbar } from "./Toolbar";
import { GroupTabs } from "./GroupTabs";

const nodeTypes: NodeTypes = {
  terminal: TerminalNode,
  group: GroupFrame,
  viewer: ViewerNode,
};

const defaultEdgeOptions: DefaultEdgeOptions = {
  type: "smoothstep",
  animated: false,
  markerEnd: {
    type: MarkerType.ArrowClosed,
    color: "var(--muted)",
  },
  style: {
    stroke: "var(--border)",
    strokeWidth: 1.5,
  },
};

/** Payload from Rust `node_created` event (must match NodeCreatedPayload in server.rs). */
interface NodeCreatedPayload {
  group_id: string;
  parent_pty_id: number;
  child_pty_id: string;
  label: string;
}

/** Payload from Rust `agent_created` event (must match AgentCreatedPayload). */
interface AgentCreatedPayload {
  group_id: string;
  name: string;
  model: string;
  prompt: string;
  color: string | null;
}

function CanvasInner() {
  const {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    addChildNode,
    addAgentDef,
    normalizeGroups,
    resolveGroupOverlap,
  } = useCanvasStore();

  // Listen for `node_created` events emitted by the MCP spawn_agent handler.
  // For each event, find the parent TerminalNode by pty_id and add a child node
  // in radial fan position with a parent→child edge inside the GroupFrame.
  useEffect(() => {
    const unlisten = listen<NodeCreatedPayload>("node_created", (event) => {
      const { group_id, parent_pty_id, child_pty_id, label } = event.payload;

      // Find the parent TerminalNode by its ptyId (set via setPtyId after spawn).
      const state = useCanvasStore.getState();
      const parentNode = state.nodes.find(
        (n) => n.type === "terminal" && "ptyId" in n.data && n.data.ptyId === parent_pty_id
      );

      const parentNodeId = parentNode?.id ?? group_id; // fallback: use group as parent

      addChildNode({
        groupId: group_id,
        parentNodeId,
        label,
        childPtyId: child_pty_id,
      });
    });

    // Listen for `agent_created` — the orchestrator saved an agent via the
    // create_agent tool; add it to the group's side menu (pick a color if none).
    const unlistenAgent = listen<AgentCreatedPayload>("agent_created", (event) => {
      const { group_id, name, model, prompt, color } = event.payload;
      const state = useCanvasStore.getState();
      const group = state.nodes.find((n) => n.id === group_id && n.type === "group");
      const used = ((group?.data as { agents?: { color: string }[] })?.agents ?? []).map(
        (a) => a.color
      );
      addAgentDef(group_id, {
        id: crypto.randomUUID(),
        name,
        model,
        prompt: prompt ?? "",
        color: color || nextAgentColor(used),
      });
    });

    return () => {
      void unlisten.then((f) => f());
      void unlistenAgent.then((f) => f());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Session restore: groups rehydrated from localStorage carry a `.mcp.json` that
  // points to LAST session's (now-dead) MCP port. Rewrite it for each restored
  // group with the current session's port so a restored parent claude can still
  // see spawn_agent. Runs once on mount; new groups handle this via the Toolbar.
  useEffect(() => {
    const groups = useCanvasStore
      .getState()
      .nodes.filter((n) => n.type === "group");
    for (const g of groups) {
      const cwd = (g.data as GroupNodeData).cwd;
      if (cwd) void invoke("create_group", { groupId: g.id, cwd }).catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hold Shift while dragging to snap nodes/groups to the 24px background grid
  // (aligns their edges with the background dots).
  const [snapActive, setSnapActive] = useState(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "Shift") setSnapActive(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Shift") setSnapActive(false);
    };
    const reset = () => setSnapActive(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", reset);
    };
  }, []);

  const isEmpty = nodes.length === 0;

  return (
    <div className="canvas-area">
      <Toolbar />
      <GroupTabs />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={(_, node) => {
          if (node.type === "group") resolveGroupOverlap(node.id);
          else normalizeGroups();
        }}
        snapToGrid={snapActive}
        snapGrid={[24, 24]}
        defaultEdgeOptions={defaultEdgeOptions}
        fitView={false}
        colorMode="dark"
        minZoom={0.1}
        maxZoom={4}
        defaultViewport={{ x: 80, y: 80, zoom: 1 }}
        deleteKeyCode="Delete"
        multiSelectionKeyCode="Shift"
        panOnDrag
        zoomOnScroll
        zoomOnDoubleClick={false}
        selectNodesOnDrag={false}
      >
        <Background
          variant={BackgroundVariant.Dots}
          color="var(--canvas-dot)"
          size={2}
          gap={24}
        />
        <Controls />
      </ReactFlow>
      {isEmpty && (
        <div className="canvas-empty-state">
          <p className="canvas-empty-heading">Nenhum grupo ainda</p>
          <p className="canvas-empty-body">Crie um grupo para começar.</p>
        </div>
      )}
    </div>
  );
}

export function Canvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
