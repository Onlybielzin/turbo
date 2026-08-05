/**
 * Toolbar — Fixed overlay anchored top-left of the canvas viewport.
 *
 * Design contract: 03-UI-SPEC.md
 * - Position: absolute top:8px left:8px z-index:10
 * - "Novo grupo" button: height 28px, padding 0 12px, 12px/400
 *
 * Phase 4 flow for "Novo grupo":
 *   1. Create the GroupFrame node immediately (canvas feedback).
 *   2. Await `create_group` Tauri command — writes `.mcp.json` AFTER health-check
 *      (D-02 ordering). Does NOT spawn claude.
 *   3. Create the parent TerminalNode with command="claude" and TURBO_GROUP_ID env.
 *      usePty spawns claude AFTER .mcp.json exists — D-02 ordering guaranteed
 *      because steps 1-2 complete before step 3 (addTerminalNode triggers mount).
 */
import { useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useCanvasStore } from "./store";
import "./Toolbar.css";

export function Toolbar() {
  const { addGroup, addTerminalNode } = useCanvasStore();

  const handleNewGroup = useCallback(async () => {
    // Open native directory picker
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Escolher pasta do grupo",
    });

    if (!selected || typeof selected !== "string") return;

    const cwd = selected;

    // 1. Create the group frame immediately for visual feedback.
    const groupId = addGroup(cwd);

    try {
      // 2. create_group: writes .mcp.json only (D-02), does NOT spawn claude.
      //    Awaiting this guarantees .mcp.json exists before usePty starts claude.
      await invoke("create_group", { groupId, cwd });

      // 3. Add the parent TerminalNode with claude + group env vars.
      //    usePty spawns claude with TURBO_GROUP_ID so spawn_agent calls are
      //    routed to the correct GroupFrame (GRP-03).
      addTerminalNode(groupId, null, cwd, "claude", [
        ["TURBO_GROUP_ID", groupId],
        ["TURBO_MCP_DEPTH", "0"],
      ]);
    } catch (err) {
      console.error("[Turbo] create_group failed:", err);
      // Fallback: open a shell so the user still has a terminal.
      addTerminalNode(groupId, null, cwd, undefined);
    }
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
