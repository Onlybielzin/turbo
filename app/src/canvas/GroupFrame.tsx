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
import { GroupNodeData } from "./store";
import { useCanvasStore } from "./store";
import "./GroupFrame.css";

type GroupFrameProps = NodeProps & { data: GroupNodeData };

function GroupFrameInner({ id, data }: GroupFrameProps) {
  const { updateNodeLabel, addTerminalNode } = useCanvasStore();

  const [editing, setEditing] = useState(false);
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

  const handleAddTerminal = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      // Determine command: try claude first, fall back to shell
      const cwd = data.cwd;
      addTerminalNode(id, null, cwd);
      // The actual PTY spawn happens inside TerminalNode/usePty on mount
    },
    [id, data.cwd, addTerminalNode]
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
        <button
          type="button"
          className="group-frame__add-terminal"
          onClick={handleAddTerminal}
          title="Adicionar terminal neste grupo"
        >
          + Novo terminal
        </button>
      </div>
      <div className="group-frame__body" />
    </div>
  );
}

export const GroupFrame = memo(GroupFrameInner);
GroupFrame.displayName = "GroupFrame";
