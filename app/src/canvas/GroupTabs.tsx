/**
 * GroupTabs — a tab bar (top of the canvas) with one chip per GroupFrame, plus
 * an Auto-grid action.
 *
 * - Clicking a tab pans/zooms the canvas to frame that group (fitView).
 * - Ctrl+1..9 jumps to the Nth group.
 * - Alt+Tab / Alt+Shift+Tab, Ctrl+E / Ctrl+Q, or Ctrl+→ / Ctrl+← cycles to the
 *   next / previous group (tab order); Ctrl+↑ / Ctrl+↓ jumps to the spatially
 *   nearest group above / below.
 * - Alt+E / Alt+Q / Alt+→ / Alt+← cycles terminals of the focused group; Alt+↑ /
 *   Alt+↓ jumps to the nearest terminal above / below — framing and focusing it.
 * - Auto-grid button / Ctrl+G lays all groups out in a neat aligned grid.
 * - Alt+G lays the focused group's terminals out in a grid with no overlap.
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

/** Center point of any node (measured > style > terminal default 780×540). Used
 *  for spatial terminal navigation; positions are parent-relative but terminals
 *  of the same group share a parent, so they're directly comparable. */
function nodeCenter(n: AppNode): { x: number; y: number } {
  const measured = (n as { measured?: { width?: number; height?: number } }).measured;
  const w = measured?.width ?? (typeof n.style?.width === "number" ? n.style.width : 780);
  const h = measured?.height ?? (typeof n.style?.height === "number" ? n.style.height : 540);
  return { x: n.position.x + w / 2, y: n.position.y + h / 2 };
}

export function GroupTabs() {
  const nodes = useCanvasStore((s) => s.nodes);
  const autoGridGroups = useCanvasStore((s) => s.autoGridGroups);
  const autoGridTerminals = useCanvasStore((s) => s.autoGridTerminals);
  const groups = nodes.filter((n) => n.type === "group");
  const { fitView } = useReactFlow();
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  // Last terminal focused via Alt navigation (for cycling / spatial nav).
  const activeTermRef = useRef<string | null>(null);

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

  // Grid the terminals of the focused group (or every group if none focused),
  // then frame the result. Alt+G.
  const doGridTerminals = useCallback(() => {
    const activeId = activeIdRef.current;
    const gs = useCanvasStore.getState().nodes.filter((n) => n.type === "group");
    const focused = activeId && gs.some((g) => g.id === activeId) ? activeId : null;
    autoGridTerminals(focused ?? undefined);
    requestAnimationFrame(() =>
      void fitView(
        focused
          ? { nodes: [{ id: focused }], duration: 400, padding: 0.18 }
          : { duration: 500, padding: 0.12 }
      )
    );
  }, [autoGridTerminals, fitView]);

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

  // Focus a terminal: frame it and hand keyboard focus to its xterm so typing
  // goes there. Terminals hibernate off-screen, so focus after the pan settles.
  const focusTerminal = useCallback(
    (termId: string) => {
      activeTermRef.current = termId;
      void fitView({ nodes: [{ id: termId }], duration: 300, padding: 0.3, maxZoom: 1 });
      window.setTimeout(() => {
        const el = document.querySelector(
          `.react-flow__node[data-id="${CSS.escape(termId)}"] .xterm-helper-textarea`
        ) as HTMLTextAreaElement | null;
        el?.focus();
      }, 340);
    },
    [fitView]
  );

  // Terminals eligible for Alt navigation: STRICTLY those of the current group —
  // Alt-nav never crosses into another group. "Current group" follows your real
  // focus, honoring BOTH cases: the terminal you're actually in right now (DOM
  // focus) AND the group you framed. Priority: the group of the focused node
  // (terminal or group), else the framed group, else the last-focused terminal's
  // group, else the first group with terminals. Returns [] if none.
  const groupTerminals = useCallback((): AppNode[] => {
    const st = useCanvasStore.getState().nodes;
    const parentOf = (id: string | null): string | null =>
      id ? st.find((n) => n.id === id)?.parentId ?? null : null;

    // Group of whatever currently holds DOM focus (a terminal you clicked into,
    // or a node) — so context tracks where you really are, not just the last tab.
    let domGid: string | null = null;
    const active = document.activeElement as HTMLElement | null;
    const nodeEl = active?.closest?.(".react-flow__node[data-id]") as HTMLElement | null;
    const domId = nodeEl?.getAttribute("data-id") ?? null;
    if (domId) {
      const n = st.find((x) => x.id === domId);
      domGid = n?.type === "group" ? n.id : n?.parentId ?? null;
    }

    const gid =
      domGid ??
      activeIdRef.current ??
      parentOf(activeTermRef.current) ??
      st.find((n) => n.type === "terminal")?.parentId ??
      null;
    if (!gid) return [];
    return st.filter((n) => n.type === "terminal" && n.parentId === gid);
  }, []);

  // Cycle terminal focus to the next (dir=+1) / previous (dir=-1), wrapping.
  const cycleTerminal = useCallback(
    (dir: 1 | -1) => {
      const terms = groupTerminals();
      if (terms.length === 0) return;
      const cur = terms.findIndex((t) => t.id === activeTermRef.current);
      const count = terms.length;
      const nextIdx = cur < 0 ? (dir === 1 ? 0 : count - 1) : (cur + dir + count) % count;
      focusTerminal(terms[nextIdx].id);
    },
    [groupTerminals, focusTerminal]
  );

  // Focus the spatially nearest terminal above / below the active one. No wrap.
  const focusSpatialTerminal = useCallback(
    (dir: "up" | "down") => {
      const terms = groupTerminals();
      if (terms.length === 0) return;
      const cur = terms.find((t) => t.id === activeTermRef.current) ?? terms[0];
      const c = nodeCenter(cur);
      const sign = dir === "up" ? -1 : 1;
      let best: AppNode | null = null;
      let bestDist = Infinity;
      for (const t of terms) {
        if (t.id === cur.id) continue;
        const tc = nodeCenter(t);
        const dy = tc.y - c.y;
        if (Math.abs(dy) < 1 || Math.sign(dy) !== sign) continue;
        const dx = tc.x - c.x;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          best = t;
        }
      }
      if (best) focusTerminal(best.id);
    },
    [groupTerminals, focusTerminal]
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
      // Grid the focused group's terminals (default Alt+G)
      if (matchBinding(e, bindings.gridTerminals)) {
        e.preventDefault();
        e.stopPropagation();
        doGridTerminals();
        return;
      }
      // Ctrl+E / Ctrl+→ → next group; Ctrl+Q / Ctrl+← → previous group;
      // Ctrl+↑ / Ctrl+↓ → spatially nearest group above / below.
      // (Ctrl so a focused terminal still gets plain arrow keys.)
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
      // Alt+E / Alt+→ → next terminal; Alt+Q / Alt+← → previous terminal;
      // Alt+↑ / Alt+↓ → spatially nearest terminal above / below — all within the
      // focused group. Frames the terminal and gives it keyboard focus.
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const k = e.key.toLowerCase();
        const isNextArrow = k === "e" || k === "arrowright";
        const isPrevArrow = k === "q" || k === "arrowleft";
        if (isNextArrow || isPrevArrow) {
          e.preventDefault();
          e.stopPropagation();
          cycleTerminal(isNextArrow ? 1 : -1);
          return;
        }
        if (k === "arrowup" || k === "arrowdown") {
          e.preventDefault();
          e.stopPropagation();
          focusSpatialTerminal(k === "arrowup" ? "up" : "down");
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
  }, [
    focusGroup,
    doAutoGrid,
    doGridTerminals,
    cycleGroup,
    focusSpatial,
    cycleTerminal,
    focusSpatialTerminal,
  ]);

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
