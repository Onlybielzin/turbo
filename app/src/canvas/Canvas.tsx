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
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  ReactFlowProvider,
  useReactFlow,
  NodeTypes,
  DefaultEdgeOptions,
  MarkerType,
  Viewport,
} from "@xyflow/react";
import { listen } from "@tauri-apps/api/event";
import "@xyflow/react/dist/style.css";
import "./canvas.css";
import { useCanvasStore, nextAgentColor } from "./store";
import { useSettingsStore } from "./settings";
import { TerminalNode } from "./TerminalNode";
import { FpsMeter } from "./FpsMeter";
import { GroupFrame } from "./GroupFrame";
import { ViewerNode } from "./ViewerNode";
import { Toolbar } from "./Toolbar";
import { GroupTabs } from "./GroupTabs";
import { SettingsModal } from "./SettingsModal";

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

  // Session restore (group MCP re-registration + terminal command recomposition)
  // happens in prepareRestore (see mcp.ts), gated by App BEFORE this canvas mounts,
  // so restored terminals spawn already wired to this session's MCP port.

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

  // LOD: reflect the current zoom onto a container attribute (data-lod-far) so
  // CSS collapses terminal bodies to placeholders when far out. The threshold is
  // user-configurable (settings store) and read live. A ref-gated diff avoids
  // touching the DOM on every frame of the zoom gesture.
  const { getViewport, setViewport } = useReactFlow();
  const areaRef = useRef<HTMLDivElement>(null);
  const lodFarRef = useRef(false);
  const zoomLabelRef = useRef<HTMLSpanElement>(null);
  const [showSettings, setShowSettings] = useState(false);

  const applyZoom = useCallback((zoom: number) => {
    const lbl = zoomLabelRef.current;
    if (lbl) lbl.textContent = `${Math.round(zoom * 100)}%`;
    const far = zoom < useSettingsStore.getState().lodZoom;
    if (far === lodFarRef.current) return;
    lodFarRef.current = far;
    const el = areaRef.current;
    if (!el) return;
    if (far) el.setAttribute("data-lod-far", "");
    else el.removeAttribute("data-lod-far");
  }, []);

  const handleMove = useCallback(
    (_e: MouseEvent | TouchEvent | null, vp: Viewport) => applyZoom(vp.zoom),
    [applyZoom]
  );

  // Gesture-settle suspend (T1): while a pan/zoom gesture is in flight, mark the
  // canvas [data-zooming] so CSS collapses every node to its cheap LOD placeholder
  // and hides the live xterm body. ReactFlow zooms via transform:scale() on the
  // whole viewport, which otherwise forces all visible terminals to re-rasterize
  // on the CPU every frame (→ ~30fps). Scaling light placeholders instead keeps
  // the gesture smooth; the flag is cleared a couple of frames after the gesture
  // ends so the last scale frame settles before the terminals repaint once.
  const zoomClearRaf = useRef<number | null>(null);
  const handleMoveStart = useCallback(() => {
    if (zoomClearRaf.current !== null) {
      cancelAnimationFrame(zoomClearRaf.current);
      zoomClearRaf.current = null;
    }
    areaRef.current?.setAttribute("data-zooming", "");
  }, []);
  const handleMoveEnd = useCallback(() => {
    if (zoomClearRaf.current !== null) cancelAnimationFrame(zoomClearRaf.current);
    zoomClearRaf.current = requestAnimationFrame(() => {
      zoomClearRaf.current = requestAnimationFrame(() => {
        zoomClearRaf.current = null;
        areaRef.current?.removeAttribute("data-zooming");
      });
    });
  }, []);

  // Re-evaluate LOD whenever the user changes the threshold (zoom hasn't moved,
  // so onMove wouldn't fire) — read the live viewport and re-apply.
  const lodZoom = useSettingsStore((s) => s.lodZoom);
  useEffect(() => {
    applyZoom(getViewport().zoom);
  }, [lodZoom, applyZoom, getViewport]);

  // Ctrl + wheel zooms the canvas even when the pointer is over a terminal.
  // Terminals carry ReactFlow's `nowheel` class so xterm can scroll its buffer —
  // which also blocks ReactFlow's own ctrl+wheel zoom there. We restore zoom by
  // intercepting the wheel in the capture phase (before xterm gets it),
  // suppressing the terminal scroll, and zooming toward the cursor ourselves.
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      const target = e.target as HTMLElement | null;
      // Only take over inside a terminal/nowheel region of THIS canvas; over the
      // pane the native zoomOnScroll already handles ctrl+wheel, so we fall
      // through there.
      if (!target?.closest(".nowheel")) return;
      if (!target.closest(".canvas-area")) return;
      e.preventDefault();
      e.stopPropagation();
      // Normalize the wheel delta to pixels. WebKitGTK (Wayland) often reports
      // deltaMode=LINE (deltaY≈±1..3) for a mouse wheel, which made the exp()
      // zoom factor ≈0.998 — imperceptible. Convert line/page deltas to pixels
      // so ctrl+wheel zooms at a usable step regardless of the reported unit.
      const LINE_PX = 16;
      const PAGE_PX = 400;
      const dy =
        e.deltaMode === 1 ? e.deltaY * LINE_PX : e.deltaMode === 2 ? e.deltaY * PAGE_PX : e.deltaY;
      const rect = area.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const vp = getViewport();
      // Flow point under the cursor — kept fixed while the zoom changes.
      const fx = (sx - vp.x) / vp.zoom;
      const fy = (sy - vp.y) / vp.zoom;
      const factor = Math.exp(-dy * 0.002);
      const zoom = Math.min(4, Math.max(0.1, vp.zoom * factor));
      setViewport({ x: sx - fx * zoom, y: sy - fy * zoom, zoom });
      applyZoom(zoom);
    };
    // Attach on `document` in the CAPTURE phase so this runs before ANY
    // element-level wheel listener (xterm's own buffer-scroll handler included),
    // regardless of DOM nesting — guaranteeing ctrl+wheel always zooms.
    document.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () =>
      document.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
  }, [getViewport, setViewport, applyZoom]);

  const isEmpty = nodes.length === 0;

  return (
    <div className="canvas-area" ref={areaRef}>
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
        onMove={handleMove}
        onMoveStart={handleMoveStart}
        onMoveEnd={handleMoveEnd}
        // Skip rendering (and painting) nodes/edges outside the viewport.
        onlyRenderVisibleElements
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
      {/* Settings gear — opens the preferences dialog (LOD threshold, shortcuts). */}
      <button
        type="button"
        className="canvas-settings-btn"
        onClick={() => setShowSettings(true)}
        title="Configurações"
        aria-label="Configurações"
      >
        ⚙
      </button>
      {/* Zoom HUD — live readout to calibrate the LOD threshold. Shows the current
          zoom % and whether terminals are live or collapsed to placeholders. */}
      <div className="zoom-indicator" aria-hidden="true">
        <span className="zoom-indicator__pct" ref={zoomLabelRef}>100%</span>
        <span className="zoom-indicator__state zoom-indicator__state--live">ao vivo</span>
        <span className="zoom-indicator__state zoom-indicator__state--lod">placeholder</span>
      </div>
      {/* Live FPS readout (bottom-left) for gauging canvas smoothness. */}
      <FpsMeter />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
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
