/**
 * Toolbar — Fixed overlay anchored top-left of the canvas viewport.
 *
 * Design contract: 03-UI-SPEC.md
 *
 * "Novo grupo" flow (per-agent backend):
 *   1. Create the GroupFrame node immediately (canvas feedback).
 *   2. Await `create_group` — registers the group, wires the embedded MCP server
 *      (writes `.mcp.json` for Claude, or returns the inline URL for Codex) and
 *      returns the parent terminal's command+args for the chosen backend.
 *   3. Create the parent TerminalNode with that command+args and the group env
 *      (TURBO_GROUP_ID / TURBO_MCP_DEPTH / TURBO_AGENT). usePty spawns it AFTER
 *      steps 1-2 complete — D-02 ordering guaranteed.
 *
 * The agent picker is the "create agents per group" area: choose which
 * CLI/model runs the group's orchestrator (Fable, Opus, Sonnet, Haiku, Codex).
 */
import { useCallback, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useCanvasStore } from "./store";
import "./Toolbar.css";

/** Command + args the backend computes for a group's parent terminal. */
type ParentSpawn = { command: string; args: string[] };

/** Agent backends selectable per group. `value` is the token sent to Rust. */
const AGENT_OPTIONS: { value: string; label: string }[] = [
  { value: "fable", label: "Fable · orquestrador" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
  { value: "codex", label: "Codex" },
];

export function Toolbar() {
  const { addGroup, addTerminalNode } = useCanvasStore();
  const [backend, setBackend] = useState("fable");

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
      // 2. Register group + wire MCP; get the parent command+args for `backend`.
      const spawn = await invoke<ParentSpawn>("create_group", {
        groupId,
        cwd,
        backend,
      });

      // 3. Add the parent TerminalNode with the computed command/args + group env.
      addTerminalNode(
        groupId,
        null,
        cwd,
        spawn.command,
        [
          ["TURBO_GROUP_ID", groupId],
          ["TURBO_MCP_DEPTH", "0"],
          ["TURBO_AGENT", backend],
        ],
        spawn.args,
      );
    } catch (err) {
      console.error("[Turbo] create_group failed:", err);
      // Fallback: open a shell so the user still has a terminal.
      addTerminalNode(groupId, null, cwd, undefined);
    }
  }, [addGroup, addTerminalNode, backend]);

  return (
    <div className="canvas-toolbar">
      <label className="canvas-toolbar__agent">
        <span className="canvas-toolbar__agent-label">Agente</span>
        <select
          className="canvas-toolbar__select"
          value={backend}
          onChange={(e) => setBackend(e.target.value)}
          aria-label="Backend do agente orquestrador"
        >
          {AGENT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
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
