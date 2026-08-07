/**
 * GroupTabs — a tab bar (top of the canvas) with one chip per GroupFrame, plus
 * an Auto-grid action.
 *
 * - Clicking a tab pans/zooms the canvas to frame that group (fitView).
 * - Ctrl+1..9 jumps to the Nth group.
 * - Alt+Tab / Alt+Shift+Tab, Ctrl+E / Ctrl+Q, or Ctrl+→ / Ctrl+← cycles to the
 *   next / previous group (tab order).
 * - Ctrl+↑ / Ctrl+↓ jumps to the spatially nearest group above / below.
 * - Auto-grid button / Ctrl+G lays all groups out in a neat aligned grid.
 *
 * Shortcuts are captured on window (capture phase) so they work even while a
 * terminal has focus. Must live inside <ReactFlowProvider> (Canvas) for useReactFlow.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { useCanvasStore, GroupNodeData, AppNode } from "./store";
import { useShortcutsStore, matchBinding } from "./shortcuts";
import "./GroupTabs.css";

/** Center point of a group node (measured size > style size > default 1120×780). */
function groupCenter(n: AppNode): { x: number; y: number } {
  const measured = (n as { measured?: { width?: number; height?: number } }).measured;
  const w = measured?.width ?? (typeof n.style?.width === "number" ? n.style.width : 1120);
  const h = measured?.height ?? (typeof n.style?.height === "number" ? n.style.height : 780);
  return { x: n.position.x + w / 2, y: n.position.y + h / 2 };
}

export function GroupTabs() {
  const nodes = useCanvasStore((s) => s.nodes);
  const autoGridGroups = useCanvasStore((s) => s.autoGridGroups);
  const groups = nodes.filter((n) => n.type === "group");
  const { fitView } = useReactFlow();
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);

  const focusGroup = useCallback(
    (groupId: string) => {
      setActiveId(groupId);
      activeIdRef.current = groupId;
      void fitView({ nodes: [{ id: groupId }], duration: 400, padding: 0.18 });
    },
    [fitView]
  );

  const doAutoGrid = useCallback(() => {
    autoGridGroups();
    // Let the store commit the new positions, then frame all groups.
    requestAnimationFrame(() => void fitView({ duration: 500, padding: 0.12 }));
  }, [autoGridGroups, fitView]);

  // Cycle focus to the next (dir=+1) or previous (dir=-1) group, wrapping around.
  const cycleGroup = useCallback(
    (dir: 1 | -1) => {
      const gs = useCanvasStore.getState().nodes.filter((n) => n.type === "group");
      if (gs.length === 0) return;
      const cur = gs.findIndex((g) => g.id === activeIdRef.current);
      const count = gs.length;
      const nextIdx = cur < 0 ? (dir === 1 ? 0 : count - 1) : (cur + dir + count) % count;
      focusGroup(gs[nextIdx].id);
    },
    [focusGroup]
  );

  // Focus the spatially nearest group above (dir="up") or below (dir="down") the
  // active one — by canvas position, not tab order. No wrap: stops at the edge.
  const focusSpatial = useCallback(
    (dir: "up" | "down") => {
      const gs = useCanvasStore.getState().nodes.filter((n) => n.type === "group");
      if (gs.length === 0) return;
      const cur = gs.find((g) => g.id === activeIdRef.current);
      if (!cur) {
        focusGroup(gs[0].id);
        return;
      }
      const c = groupCenter(cur);
      const sign = dir === "up" ? -1 : 1;
      let best: AppNode | null = null;
      let bestDist = Infinity;
      for (const g of gs) {
        if (g.id === cur.id) continue;
        const gc = groupCenter(g);
        const dy = gc.y - c.y;
        // Must lie in the requested vertical direction (with a small deadzone).
        if (Math.abs(dy) < 1 || Math.sign(dy) !== sign) continue;
        const dx = gc.x - c.x;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          best = g;
        }
      }
      if (best) focusGroup(best.id);
    },
    [focusGroup]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { bindings } = useShortcutsStore.getState();
      // Auto-grid layout (default Ctrl+G)
      if (matchBinding(e, bindings.autoGrid)) {
        e.preventDefault();
        e.stopPropagation();
        doAutoGrid();
        return;
      }
      // Ctrl+E / Ctrl+→ → next group; Ctrl+Q / Ctrl+← → previous group.
      // (Arrows use Ctrl so a focused terminal still gets plain arrow keys.)
      if (e.ctrlKey && !e.altKey && !e.metaKey) {
        const k = e.key.toLowerCase();
        const isNextArrow = k === "e" || k === "arrowright";
        const isPrevArrow = k === "q" || k === "arrowleft";
        if (isNextArrow || isPrevArrow) {
          e.preventDefault();
          e.stopPropagation();
          cycleGroup(isNextArrow ? 1 : -1);
          return;
        }
        if (k === "arrowup" || k === "arrowdown") {
          e.preventDefault();
          e.stopPropagation();
          focusSpatial(k === "arrowup" ? "up" : "down");
          return;
        }
      }
      // Next / previous group (configurable — default Alt+Tab / Alt+Shift+Tab)
      const isNext = matchBinding(e, bindings.nextGroup);
      const isPrev = matchBinding(e, bindings.prevGroup);
      if (isNext || isPrev) {
        if (useCanvasStore.getState().nodes.every((n) => n.type !== "group")) return;
        e.preventDefault();
        e.stopPropagation();
        cycleGroup(isNext ? 1 : -1);
        return;
      }
      // Ctrl+1..9 → jump to group N
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key < "1" || e.key > "9") return;
      const idx = Number(e.key) - 1;
      const gs = useCanvasStore.getState().nodes.filter((n) => n.type === "group");
      const g = gs[idx];
      if (!g) return;
      e.preventDefault();
      e.stopPropagation();
      focusGroup(g.id);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [focusGroup, doAutoGrid, cycleGroup, focusSpatial]);

  if (groups.length === 0) return null;

  return (
    <div className="group-tabs" role="tablist" aria-label="Grupos">
      <button
        type="button"
        className="group-tab group-tab--action"
        onClick={doAutoGrid}
        title="Auto-grid — organizar grupos em grade (Ctrl+G)"
      >
        <span className="group-tab__grid-icon" aria-hidden="true" />
        <span className="group-tab__label">Auto-grid</span>
      </button>
      <span className="group-tabs__sep" aria-hidden="true" />
      {groups.map((g, i) => (
        <button
          key={g.id}
          type="button"
          role="tab"
          aria-selected={activeId === g.id}
          className={`group-tab${activeId === g.id ? " group-tab--active" : ""}`}
          onClick={() => focusGroup(g.id)}
          title={`${(g.data as GroupNodeData).label} — Ctrl+${i + 1}`}
        >
          <span className="group-tab__index">{i + 1}</span>
          <span className="group-tab__label">{(g.data as GroupNodeData).label}</span>
        </button>
      ))}
    </div>
  );
}
