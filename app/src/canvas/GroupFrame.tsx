/**
 * GroupFrame — Custom @xyflow/react group node that contains TerminalNodes.
 *
 * Design contract: 03-UI-SPEC.md
 * - Label bar: 28px, --panel bg, border-bottom --group-border
 * - Group label: 14px/400, editable on double-click (inline contenteditable)
 * - cwd path: 11px/400 monospace, --muted, text-overflow ellipsis
 * - "+ Novo terminal" button: visible on label bar hover
 * - Body: --group-bg, child nodes constrained via parentId + extent:'parent'
 * - Frame border: 1px --group-border, border-radius 8px
 * - Default size: 800×600px (set in store.addGroup)
 */
import { memo, useRef, useState, useCallback } from "react";
import { NodeProps } from "@xyflow/react";
import { invoke } from "@tauri-apps/api/core";
import { GroupNodeData, AGENT_OPTIONS, useCanvasStore } from "./store";
import "./GroupFrame.css";

/** Command + args the backend computes for an agent terminal. */
type ParentSpawn = { command: string; args: string[] };

type GroupFrameProps = NodeProps & { data: GroupNodeData };

function GroupFrameInner({ id, data }: GroupFrameProps) {
  const { updateNodeLabel, addTerminalNode } = useCanvasStore();

  const [editing, setEditing] = useState(false);
  // "Agentes" panel: model + optional custom prompt for the next agent to add.
  const [memberModel, setMemberModel] = useState(data.backend ?? "fable");
  const [memberPrompt, setMemberPrompt] = useState("");
  const labelRef = useRef<HTMLSpanElement>(null);

  const handleDoubleClick = useCallback(() => {
    setEditing(true);
    // Focus the contenteditable after state update
    requestAnimationFrame(() => {
      if (labelRef.current) {
        labelRef.current.focus();
        // Select all text
        const range = document.createRange();
        range.selectNodeContents(labelRef.current);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    });
  }, [data.label]);

  const commitLabel = useCallback(() => {
    const newLabel = labelRef.current?.textContent?.trim() || data.label;
    updateNodeLabel(id, newLabel ?? data.label);
    setEditing(false);
  }, [id, data.label, updateNodeLabel]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitLabel();
      } else if (e.key === "Escape") {
        // Revert
        if (labelRef.current) {
          labelRef.current.textContent = data.label;
        }
        setEditing(false);
      }
    },
    [commitLabel, data.label]
  );

  const handleAddAgent = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      const cwd = data.cwd;
      try {
        // Wire MCP for THIS agent's backend (writes .mcp.json for Claude or
        // returns the inline URL for Codex) and get its launch command+args.
        const spawn = await invoke<ParentSpawn>("create_group", {
          groupId: id,
          cwd,
          backend: memberModel,
        });
        // A custom prompt is passed as the interactive CLI's positional [PROMPT].
        const args = memberPrompt.trim()
          ? [...spawn.args, memberPrompt.trim()]
          : spawn.args;
        addTerminalNode(
          id,
          null,
          cwd,
          spawn.command,
          [
            ["TURBO_GROUP_ID", id],
            ["TURBO_MCP_DEPTH", "0"],
            ["TURBO_AGENT", memberModel],
          ],
          args,
        );
        setMemberPrompt("");
      } catch (err) {
        console.error("[Turbo] add agent failed:", err);
        addTerminalNode(id, null, cwd);
      }
    },
    [id, data.cwd, memberModel, memberPrompt, addTerminalNode]
  );

  const cwdDisplay = data.cwd
    ? data.cwd.replace(/^\/home\/[^/]+/, "~")
    : "";

  return (
    <div className="group-frame">
      <div className="group-frame__label-bar">
        <span
          ref={labelRef}
          className="group-frame__label"
          contentEditable={editing}
          suppressContentEditableWarning
          onDoubleClick={handleDoubleClick}
          onBlur={commitLabel}
          onKeyDown={handleKeyDown}
        >
          {data.label}
        </span>
        <span className="group-frame__cwd" title={data.cwd}>
          {cwdDisplay}
        </span>
        <div className="group-frame__agents" onDoubleClick={(e) => e.stopPropagation()}>
          <span className="group-frame__agents-title">Agentes</span>
          <select
            className="group-frame__agent-model"
            value={memberModel}
            onChange={(e) => setMemberModel(e.target.value)}
            aria-label="Modelo do agente"
            title="Modelo/CLI do agente"
          >
            {AGENT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <input
            className="group-frame__agent-prompt"
            type="text"
            value={memberPrompt}
            onChange={(e) => setMemberPrompt(e.target.value)}
            placeholder="Prompt (opcional)"
            title="Prompt inicial / papel do agente"
          />
          <button
            type="button"
            className="group-frame__add-terminal"
            onClick={handleAddAgent}
            title="Adicionar agente neste projeto"
          >
            + Agente
          </button>
        </div>
      </div>
      <div className="group-frame__body" />
    </div>
  );
}

export const GroupFrame = memo(GroupFrameInner);
GroupFrame.displayName = "GroupFrame";
