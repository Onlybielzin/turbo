/**
 * GroupFrame — Custom @xyflow/react group node that contains TerminalNodes.
 *
 * The group is a project = a team of saved agents. Its right-side menu lists the
 * agents (persist until deleted); each has "Abrir terminal" (opens its terminal
 * on demand, colored + named after the agent) and a delete button. "+ Criar
 * agente" opens the CreateAgentModal — creating an agent only saves it.
 *
 * Below the label bar a thin "lanes" bar shows one chip per git worktree found
 * in the repo. Clicking a chip selects that worktree as the active raia; new
 * terminals will run with cwd = that worktree. "+ Worktree" creates a new one.
 */
import { memo, useRef, useState, useCallback, useEffect } from "react";
import { NodeProps } from "@xyflow/react";
import { invoke } from "@tauri-apps/api/core";
import {
  GroupNodeData,
  Worktree,
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
  const setGroupWorktrees = useCanvasStore((s) => s.setGroupWorktrees);
  const setActiveWorktree = useCanvasStore((s) => s.setActiveWorktree);
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
  const worktrees = data.worktrees ?? [];
  // Synthetic root lane always present even if git returned nothing.
  const rootLane: Worktree = { path: data.cwd, branch: "root", is_root: true };
  const lanes: Worktree[] = worktrees.length > 0 ? worktrees : [rootLane];
  const activeWorktree = data.activeWorktree ?? data.cwd;

  // Load worktrees on mount (or when the group's cwd changes).
  useEffect(() => {
    let cancelled = false;
    invoke<Worktree[]>("list_worktrees", { cwd: data.cwd })
      .then((list) => {
        if (cancelled) return;
        if (list.length > 0) {
          setGroupWorktrees(id, list);
        }
      })
      .catch(() => {
        // Not a git repo or git not installed — leave lanes empty (root only).
      });
    return () => {
      cancelled = true;
    };
  }, [id, data.cwd, setGroupWorktrees]);

  const handleCreateWorktree = useCallback(async () => {
    const name = window.prompt("Nome da worktree (ex: feature-x):");
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    try {
      await invoke<Worktree>("create_worktree", {
        cwd: data.cwd,
        name: trimmed,
        branch: trimmed,
        newBranch: true,
      });
      // Re-fetch to include the new worktree
      const updated = await invoke<Worktree[]>("list_worktrees", { cwd: data.cwd });
      setGroupWorktrees(id, updated);
      setActiveWorktree(id, `${data.cwd}/.claude/worktrees/${trimmed}`);
    } catch (err) {
      window.alert(`Erro ao criar worktree: ${String(err)}`);
    }
  }, [id, data.cwd, setGroupWorktrees, setActiveWorktree]);

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
        // Use the active worktree raia as the working directory.
        // create_group writes .mcp.json into wtPath (WT-04) and returns the
        // launch command+args for the chosen backend.
        const wtPath = data.activeWorktree ?? data.cwd;
        const sessionId = crypto.randomUUID();
        const spawn = await invoke<ParentSpawn>("create_group", {
          groupId: id,
          cwd: wtPath,
          backend: agent.model,
          prompt: agent.prompt || null,
          sessionId,
        });
        const nodeId = addTerminalNode(
          id,
          null,
          wtPath,
          spawn.command,
          [
            ["TURBO_GROUP_ID", id],
            ["TURBO_MCP_DEPTH", "0"],
            ["TURBO_AGENT", agent.model],
            ["TURBO_WORKTREE_CWD", wtPath],
          ],
          spawn.args,
          agent.color,
          sessionId,
          wtPath,
        );
        updateNodeLabel(nodeId, agent.name);
      } catch (err) {
        console.error("[Turbo] open terminal failed:", err);
      }
    },
    [id, data.cwd, data.activeWorktree, addTerminalNode, updateNodeLabel]
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
      {/* Worktree lanes bar — one chip per git worktree, nodrag so clicks don't pan */}
      <div className="group-frame__lanes nodrag">
        {lanes.map((wt) => (
          <button
            key={wt.path}
            type="button"
            className={`group-frame__lane${wt.path === activeWorktree ? " is-active" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              setActiveWorktree(id, wt.path);
            }}
            title={wt.path}
          >
            {wt.branch}
          </button>
        ))}
        <button
          type="button"
          className="group-frame__lane-add"
          onClick={(e) => {
            e.stopPropagation();
            void handleCreateWorktree();
          }}
          title="Criar nova worktree"
        >
          + Worktree
        </button>
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
