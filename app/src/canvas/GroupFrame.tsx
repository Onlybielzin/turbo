/**
 * GroupFrame — Custom @xyflow/react group node that contains TerminalNodes.
 *
 * The group is a project = a team of saved agents. Its right-side menu lists the
 * agents (persist until deleted); each has "Abrir terminal" (opens its terminal
 * on demand, colored + named after the agent) and a delete button. "+ Criar
 * agente" opens the CreateAgentModal — creating an agent only saves it.
 */
import { memo, useRef, useState, useCallback } from "react";
import { NodeProps } from "@xyflow/react";
import { invoke } from "@tauri-apps/api/core";
import {
  GroupNodeData,
  AgentDef,
  nextAgentColor,
  useCanvasStore,
} from "./store";
import { CreateAgentModal } from "./CreateAgentModal";
import { sumUsage, formatTokens, formatCost, groupLevel } from "./usage";
import "./GroupFrame.css";

type GroupFrameProps = NodeProps & { data: GroupNodeData };
type ParentSpawn = { command: string; args: string[] };

function GroupFrameInner({ id, data }: GroupFrameProps) {
  const updateNodeLabel = useCanvasStore((s) => s.updateNodeLabel);
  const addTerminalNode = useCanvasStore((s) => s.addTerminalNode);
  const removeAgentDef = useCanvasStore((s) => s.removeAgentDef);
  const nodes = useCanvasStore((s) => s.nodes);
  const usageByNode = useCanvasStore((s) => s.usageByNode);

  // Sum token/cost usage across this project's open terminals.
  const groupTotal = sumUsage(
    nodes
      .filter((n) => n.parentId === id && n.type === "terminal")
      .map((n) => usageByNode[n.id])
      .filter((u): u is NonNullable<typeof u> => Boolean(u))
  );

  const [editing, setEditing] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const labelRef = useRef<HTMLSpanElement>(null);

  const agents = data.agents ?? [];

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

  const openTerminal = useCallback(
    async (agent: AgentDef) => {
      try {
        // Wire MCP for the agent's backend and get its launch command+args
        // (role baked in as a system prompt by create_group, not positional).
        const sessionId = crypto.randomUUID();
        const spawn = await invoke<ParentSpawn>("create_group", {
          groupId: id,
          cwd: data.cwd,
          backend: agent.model,
          prompt: agent.prompt || null,
          sessionId,
        });
        const nodeId = addTerminalNode(
          id,
          null,
          data.cwd,
          spawn.command,
          [
            ["TURBO_GROUP_ID", id],
            ["TURBO_MCP_DEPTH", "0"],
            ["TURBO_AGENT", agent.model],
          ],
          spawn.args,
          agent.color,
          sessionId,
        );
        updateNodeLabel(nodeId, agent.name);
      } catch (err) {
        console.error("[Turbo] open terminal failed:", err);
      }
    },
    [id, data.cwd, addTerminalNode, updateNodeLabel]
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

        {(() => {
          const lvl = groupLevel(groupTotal.total_tokens);
          return (
            <div className="group-frame__level" title="Nível do projeto — sobe conforme o grupo gasta tokens">
              <div className="group-frame__level-row">
                <span className="group-frame__level-badge">Nv {lvl.level}</span>
                <span className="group-frame__level-caption">
                  {lvl.nextAt
                    ? `${formatTokens(groupTotal.total_tokens)} / ${formatTokens(lvl.nextAt)} tok`
                    : "máx"}
                </span>
              </div>
              <div className="group-frame__level-bar">
                <div
                  className="group-frame__level-fill"
                  style={{ width: `${Math.round(lvl.progress * 100)}%` }}
                />
              </div>
            </div>
          );
        })()}
        <div className="group-frame__roster">
          {agents.length === 0 ? (
            <p className="group-frame__empty">Nenhum agente ainda.</p>
          ) : (
            agents.map((a) => (
              <div key={a.id} className="group-frame__agent-row">
                <span
                  className="group-frame__agent-dot"
                  style={{ background: a.color }}
                />
                <div className="group-frame__agent-info">
                  <span className="group-frame__agent-name" title={a.prompt}>
                    {a.name}
                  </span>
                  <span className="group-frame__agent-badge">{a.model}</span>
                </div>
                <button
                  type="button"
                  className="group-frame__agent-open"
                  onClick={(e) => {
                    e.stopPropagation();
                    void openTerminal(a);
                  }}
                  title="Abrir terminal deste agente"
                >
                  Abrir
                </button>
                <button
                  type="button"
                  className="group-frame__agent-del"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeAgentDef(id, a.id);
                  }}
                  title="Excluir agente"
                  aria-label="Excluir agente"
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
        {groupTotal.total_tokens > 0 && (
          <div className="group-frame__total" title="Soma de tokens e custo estimado dos terminais abertos deste projeto">
            <span className="group-frame__total-label">Total</span>
            <span className="group-frame__total-value">
              {formatTokens(groupTotal.total_tokens)} tok · {formatCost(groupTotal.cost_usd)}
            </span>
          </div>
        )}
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
          defaultColor={nextAgentColor(agents.map((a) => a.color))}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}

export const GroupFrame = memo(GroupFrameInner);
GroupFrame.displayName = "GroupFrame";
