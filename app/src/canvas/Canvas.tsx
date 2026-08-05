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
import { useEffect } from "react";
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
import "@xyflow/react/dist/style.css";
import "./canvas.css";
import { useCanvasStore } from "./store";
import { TerminalNode } from "./TerminalNode";
import { GroupFrame } from "./GroupFrame";
import { Toolbar } from "./Toolbar";

const nodeTypes: NodeTypes = {
  terminal: TerminalNode,
  group: GroupFrame,
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

function CanvasInner() {
  const { nodes, edges, onNodesChange, onEdgesChange, onConnect, addChildNode } =
    useCanvasStore();

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

    return () => {
      void unlisten.then((f) => f());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isEmpty = nodes.length === 0;

  return (
    <div className="canvas-area">
      <Toolbar />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
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
