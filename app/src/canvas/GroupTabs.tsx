/**
 * GroupTabs — a tab bar (top of the canvas) with one chip per GroupFrame, plus
 * an Auto-grid action.
 *
 * - Clicking a tab pans/zooms the canvas to frame that group (fitView).
 * - Ctrl+1..9 jumps to the Nth group.
 * - Alt+Tab / Alt+Shift+Tab cycles to the next / previous group.
 * - Auto-grid button / Ctrl+G lays all groups out in a neat aligned grid.
 *
 * Shortcuts are captured on window (capture phase) so they work even while a
 * terminal has focus. Must live inside <ReactFlowProvider> (Canvas) for useReactFlow.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { useCanvasStore, GroupNodeData } from "./store";
import "./GroupTabs.css";

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+G → auto-grid layout
      if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "g" || e.key === "G")) {
        e.preventDefault();
        e.stopPropagation();
        doAutoGrid();
        return;
      }
      // Alt+Tab / Alt+Shift+Tab → next / previous group
      if (e.altKey && e.key === "Tab") {
        const gs = useCanvasStore.getState().nodes.filter((n) => n.type === "group");
        if (gs.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        const cur = gs.findIndex((g) => g.id === activeIdRef.current);
        const count = gs.length;
        const nextIdx =
          cur < 0 ? 0 : e.shiftKey ? (cur - 1 + count) % count : (cur + 1) % count;
        focusGroup(gs[nextIdx].id);
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
  }, [focusGroup, doAutoGrid]);

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
