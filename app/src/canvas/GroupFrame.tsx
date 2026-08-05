/**
 * GroupFrame — Custom @xyflow/react group node that contains TerminalNodes.
 *
 * The group is a project = a team of agents. Its right-side menu lists the
 * agents created in the project; "+ Criar agente" opens the CreateAgentModal
 * (presets + custom model/prompt). The first agent is the orchestrator.
 */
import { memo, useRef, useState, useCallback } from "react";
import { NodeProps } from "@xyflow/react";
import { GroupNodeData, TerminalNodeData, useCanvasStore } from "./store";
import { CreateAgentModal } from "./CreateAgentModal";
import "./GroupFrame.css";

type GroupFrameProps = NodeProps & { data: GroupNodeData };

/** Human label for the backend a terminal runs (from its TURBO_AGENT env). */
function agentModel(d: TerminalNodeData): string {
  const fromEnv = d.env?.find(([k]) => k === "TURBO_AGENT")?.[1];
  return fromEnv || d.command || "shell";
}

function GroupFrameInner({ id, data }: GroupFrameProps) {
  const updateNodeLabel = useCanvasStore((s) => s.updateNodeLabel);
  const nodes = useCanvasStore((s) => s.nodes);
  const agents = nodes.filter((n) => n.parentId === id && n.type === "terminal");

  const [editing, setEditing] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const labelRef = useRef<HTMLSpanElement>(null);

  const handleDoubleClick = useCallback(() => {
    setEditing(true);
    requestAnimationFrame(() => {
      if (labelRef.current) {
        labelRef.current.focus();
        const range = document.createRange();
        range.selectNodeContents(labelRef.current);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    });
  }, []);

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
        if (labelRef.current) {
          labelRef.current.textContent = data.label;
        }
        setEditing(false);
      }
    },
    [commitLabel, data.label]
  );

  const cwdDisplay = data.cwd ? data.cwd.replace(/^\/home\/[^/]+/, "~") : "";

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
      </div>
      <div className="group-frame__body" />

      <aside className="group-frame__sidebar nodrag">
        <div className="group-frame__sidebar-head">
          <span className="group-frame__sidebar-title">Agentes</span>
          <span className="group-frame__sidebar-count">{agents.length}</span>
        </div>
        <div className="group-frame__roster">
          {agents.length === 0 ? (
            <p className="group-frame__empty">Nenhum agente ainda.</p>
          ) : (
            agents.map((a) => {
              const d = a.data as TerminalNodeData;
              return (
                <div key={a.id} className="group-frame__agent-row">
                  <span className="group-frame__agent-name">{String(d.label)}</span>
                  <span className="group-frame__agent-badge">{agentModel(d)}</span>
                </div>
              );
            })
          )}
        </div>
        <button
          type="button"
          className="group-frame__create"
          onClick={(e) => {
            e.stopPropagation();
            setModalOpen(true);
          }}
        >
          + Criar agente
        </button>
      </aside>

      {modalOpen && (
        <CreateAgentModal
          groupId={id}
          cwd={data.cwd}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}

export const GroupFrame = memo(GroupFrameInner);
GroupFrame.displayName = "GroupFrame";
