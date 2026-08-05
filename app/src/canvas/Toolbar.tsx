/**
 * Toolbar — Fixed overlay anchored top-left of the canvas viewport.
 *
 * Design contract: 03-UI-SPEC.md
 * - Position: absolute top:8px left:8px z-index:10
 * - "Novo grupo" button: height 28px, padding 0 12px, 12px/400
 *
 * Phase 4: "Novo grupo" now calls the `create_group` Tauri command which:
 *   1. Writes `.mcp.json` into the cwd AFTER the MCP server health-check (D-02).
 *   2. Launches `claude` as the parent agent in that cwd.
 *   3. Returns the PTY id for the parent TerminalNode.
 *
 * The group node and parent TerminalNode are created in the store first (for
 * immediate canvas feedback), then the PTY id is wired back via setPtyId.
 */
import { useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke, Channel } from "@tauri-apps/api/core";
import { useCanvasStore } from "./store";
import "./Toolbar.css";

export function Toolbar() {
  const { addGroup, addTerminalNode, setPtyId } = useCanvasStore();

  const handleNewGroup = useCallback(async () => {
    // Open native directory picker
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Escolher pasta do grupo",
    });

    if (!selected || typeof selected !== "string") return;

    const cwd = selected;

    // Create the group node and a placeholder parent terminal node immediately
    // so the user sees canvas feedback before the PTY is ready.
    const groupId = addGroup(cwd);
    const nodeId = addTerminalNode(groupId, null, cwd, "claude");

    // Channel to stream PTY output to this TerminalNode's xterm instance.
    // The TerminalNode's usePty hook also creates a channel — here we create a
    // separate one for the create_group command so Rust can stream the parent
    // claude output. The usePty hook on the node will open its own channel on mount.
    //
    // NOTE: Because usePty opens its own channel on mount, we use create_group
    // only to trigger the .mcp.json write + claude spawn. The PTY id returned
    // is wired back so usePty can communicate with the correct session.
    const onData = new Channel<number[]>();
    onData.onmessage = () => {
      // Output is forwarded by usePty's own channel — this channel just keeps
      // the Rust side happy (create_group requires an on_data channel param).
    };

    try {
      const ptyId = await invoke<number>("create_group", {
        groupId,
        cwd,
        onData,
      });
      // Wire the real PTY id back to the node so usePty can communicate with it.
      setPtyId(nodeId, ptyId);
    } catch (err) {
      console.error("[Turbo] create_group failed:", err);
    }
  }, [addGroup, addTerminalNode, setPtyId]);

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
