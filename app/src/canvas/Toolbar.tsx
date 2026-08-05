/**
 * Toolbar — Fixed overlay anchored top-left of the canvas viewport.
 *
 * Design contract: 03-UI-SPEC.md
 * - Position: absolute top:8px left:8px z-index:10
 * - "Novo grupo" button: height 28px, padding 0 12px, 12px/400
 * - On click: Tauri native directory picker → create GroupFrame → auto-launch claude
 */
import { useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useCanvasStore } from "./store";
import "./Toolbar.css";

export function Toolbar() {
  const { addGroup, addTerminalNode } = useCanvasStore();

  const handleNewGroup = useCallback(async () => {
    // Open native directory picker (Tauri plugin-dialog)
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Escolher pasta do grupo",
    });

    if (!selected || typeof selected !== "string") return;

    const cwd = selected;
    const groupId = addGroup(cwd);

    // Auto-launch claude in the group's cwd.
    // The command "claude" is stored in the node data and passed to usePty on mount.
    // usePty falls back to the shell if claude is not in PATH (handled in Rust via pty_spawn).
    addTerminalNode(groupId, null, cwd, "claude");
  }, [addGroup, addTerminalNode]);

  return (
    <div className="canvas-toolbar">
      <button
        type="button"
        className="canvas-toolbar__btn"
        onClick={handleNewGroup}
      >
        + Novo grupo
      </button>
    </div>
  );
}
