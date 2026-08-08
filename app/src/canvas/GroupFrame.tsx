/**
 * GroupFrame — Custom @xyflow/react group node that contains TerminalNodes.
 *
 * The group is a project = a team of saved agents. Its right-side menu lists the
 * agents (persist until deleted); each has "Abrir terminal" (opens its terminal
 * on demand, colored + named after the agent) and a delete button. "+ Criar
 * agente" opens the CreateAgentModal — creating an agent only saves it.
 *
 * Below the label bar (only on the repo/root group) a thin "lanes" bar shows one
 * chip per git worktree found in the repo. Clicking a chip opens (or focuses) a
 * dedicated subgroup frame for that worktree — a sibling group whose cwd is the
 * worktree path, so its terminals run there. "+ Worktree" creates a new one.
 */
import { memo, useRef, useState, useCallback, useEffect } from "react";
import { NodeProps } from "@xyflow/react";
import { invoke } from "@tauri-apps/api/core";
import {
  GroupNodeData,
  TerminalNodeData,
  UsageReport,
  Worktree,
  AgentDef,
  nextAgentColor,
  useCanvasStore,
} from "./store";
import { CreateAgentModal } from "./CreateAgentModal";
import { Mascot } from "./mascot/Mascot";
import { isActive } from "./activity";
import { sumUsage, formatTokens, formatCost, groupLevel } from "./usage";
import "./GroupFrame.css";

type GroupFrameProps = NodeProps & { data: GroupNodeData };
type ParentSpawn = { command: string; args: string[] };

function GroupFrameInner({ id, data }: GroupFrameProps) {
  const updateNodeLabel = useCanvasStore((s) => s.updateNodeLabel);
  const addTerminalNode = useCanvasStore((s) => s.addTerminalNode);
  const removeAgentDef = useCanvasStore((s) => s.removeAgentDef);
  const setGroupWorktrees = useCanvasStore((s) => s.setGroupWorktrees);
  const openWorktreeGroup = useCanvasStore((s) => s.openWorktreeGroup);
  const removeNode = useCanvasStore((s) => s.removeNode);
  const nodes = useCanvasStore((s) => s.nodes);
  const usageByNode = useCanvasStore((s) => s.usageByNode);

  // A group's OWN total = usage of its currently-open terminals PLUS the
  // persisted cumulative of terminals already closed (usageTotal). This keeps
  // the running total fixed — it never drops when a terminal is closed.
  const ownTotalOf = (groupNodeId: string, persisted?: UsageReport) => {
    const openUsage = nodes
      .filter((n) => n.parentId === groupNodeId && n.type === "terminal")
      .map((n) => usageByNode[n.id])
      .filter((u): u is NonNullable<typeof u> => Boolean(u));
    return sumUsage(persisted ? [persisted, ...openUsage] : openUsage);
  };

  // Group total = this group's own usage. The principal (repo root) group ALSO
  // absorbs the XP earned in its worktree subgroups (groups whose worktreeOf
  // points back here); each worktree subgroup still keeps its own total.
  const worktreeSubtotals = data.worktreeOf
    ? []
    : nodes
        .filter(
          (n) =>
            n.type === "group" && (n.data as GroupNodeData).worktreeOf === id,
        )
        .map((n) => ownTotalOf(n.id, (n.data as GroupNodeData).usageTotal));
  const groupTotal = sumUsage([
    ownTotalOf(id, data.usageTotal),
    ...worktreeSubtotals,
  ]);

  const lvl = groupLevel(groupTotal.total_tokens);
  // Re-render on a 1s tick so WORK/REST tracks live PTY activity.
  const [, activityTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => activityTick((x) => (x + 1) % 1_000_000), 1000);
    return () => clearInterval(t);
  }, []);
  // "Working" = a child terminal produced output in the last ~2.5s (agent
  // actively busy), NOT merely that a running process exists.
  const working = nodes.some(
    (n) => n.parentId === id && n.type === "terminal" && isActive(n.id),
  );

  const [editing, setEditing] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  // When set, the create-agent modal opens in edit mode for this agent.
  const [editingAgent, setEditingAgent] = useState<AgentDef | null>(null);
  const [levelUpTo, setLevelUpTo] = useState<number | null>(null);
  const prevLevelRef = useRef(lvl.level);
  const labelRef = useRef<HTMLSpanElement>(null);

  // Show a corner toast when the group levels up.
  useEffect(() => {
    if (lvl.level > prevLevelRef.current) {
      setLevelUpTo(lvl.level);
      prevLevelRef.current = lvl.level;
      const t = setTimeout(() => setLevelUpTo(null), 3500);
      return () => clearTimeout(t);
    }
    prevLevelRef.current = lvl.level;
  }, [lvl.level]);

  const agents = data.agents ?? [];
  const worktrees = data.worktrees ?? [];
  // Synthetic root lane always present even if git returned nothing.
  const rootLane: Worktree = { path: data.cwd, branch: "root", is_root: true };
  const lanes: Worktree[] = worktrees.length > 0 ? worktrees : [rootLane];
  // A worktree subgroup doesn't show the lanes bar — it IS one worktree.
  const isWorktreeGroup = Boolean(data.worktreeOf);
  // Which worktree paths already have an open group frame (for chip highlight).
  const openCwds = new Set(
    nodes
      .filter((n) => n.type === "group")
      .map((n) => (n.data as GroupNodeData).cwd)
  );

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
      // Re-fetch to include the new worktree, then open its subgroup frame.
      const updated = await invoke<Worktree[]>("list_worktrees", { cwd: data.cwd });
      setGroupWorktrees(id, updated);
      const newPath = `${data.cwd}/.claude/worktrees/${trimmed}`;
      const created = updated.find((w) => w.path === newPath);
      openWorktreeGroup(id, created ?? { path: newPath, branch: trimmed, is_root: false });
    } catch (err) {
      window.alert(`Erro ao criar worktree: ${String(err)}`);
    }
  }, [id, data.cwd, setGroupWorktrees, openWorktreeGroup]);

  // Close a group (project or worktree subgroup): kill its terminals' PTYs, then
  // drop the frame. Confirms first — closing loses the group and its terminals.
  const handleCloseGroup = useCallback(() => {
    const msg = isWorktreeGroup
      ? "Fechar este subgrupo de worktree? Os terminais abertos serão encerrados."
      : `Fechar o grupo "${data.label}"? Todos os terminais abertos serão encerrados.`;
    if (!window.confirm(msg)) return;
    for (const n of nodes) {
      if (n.parentId === id && n.type === "terminal") {
        const pid = (n.data as TerminalNodeData).ptyId;
        if (typeof pid === "number") void invoke("pty_kill", { id: pid });
      }
    }
    removeNode(id);
  }, [id, nodes, removeNode, isWorktreeGroup, data.label]);

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
          resume: false,
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
            // Real display name, so the agent can identify itself as the sender
            // in send_message (from = $TURBO_AGENT_NAME).
            ["TURBO_AGENT_NAME", agent.name],
            ["TURBO_WORKTREE_CWD", wtPath],
          ],
          spawn.args,
          agent.color,
          sessionId,
          wtPath,
          // Stable identity persisted for restore recomposition (see prepareRestore).
          agent.model,
          agent.prompt || undefined,
          // Link the terminal back to its AgentDef so renames re-sync the label.
          agent.id,
        );
        updateNodeLabel(nodeId, agent.name);
      } catch (err) {
        console.error("[Turbo] open terminal failed:", err);
      }
    },
    [id, data.cwd, data.activeWorktree, addTerminalNode, updateNodeLabel]
  );

  // Open a plain shell terminal (no agent) in the group's active worktree cwd.
  // No command/args → usePty spawns the default shell; no color → status-dot node.
  const openPlainTerminal = useCallback(() => {
    const wtPath = data.activeWorktree ?? data.cwd;
    const nodeId = addTerminalNode(id, null, wtPath, undefined, [
      ["TURBO_GROUP_ID", id],
      ["TURBO_WORKTREE_CWD", wtPath],
    ]);
    updateNodeLabel(nodeId, "Terminal");
  }, [id, data.cwd, data.activeWorktree, addTerminalNode, updateNodeLabel]);

  const cwdDisplay = data.cwd ? data.cwd.replace(/^\/home\/[^/]+/, "~") : "";

  return (
    <div className="group-frame">
      {levelUpTo !== null && (
        <div className="group-frame__levelup nodrag" role="status">
          ⬆ Nível {levelUpTo} · {formName(levelUpTo)}
        </div>
      )}
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
          className="group-frame__close nodrag"
          onClick={(e) => {
            e.stopPropagation();
            handleCloseGroup();
          }}
          title={
            isWorktreeGroup
              ? "Fechar subgrupo da worktree (mata os terminais)"
              : "Fechar grupo (mata os terminais)"
          }
          aria-label={isWorktreeGroup ? "Fechar subgrupo da worktree" : "Fechar grupo"}
        >
          ✕
        </button>
      </div>
      {/* Worktree lanes bar — one chip per git worktree, nodrag so clicks don't pan.
          Only on the repo/root group; a worktree subgroup doesn't show it. */}
      {!isWorktreeGroup && (
        <div className="group-frame__lanes nodrag">
          {lanes.map((wt) => (
            <button
              key={wt.path}
              type="button"
              className={`group-frame__lane${openCwds.has(wt.path) ? " is-active" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                // Opens (or focuses) the subgroup frame for this worktree.
                // For the root worktree this resolves to this very group (no-op).
                openWorktreeGroup(id, wt);
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
      )}

      <div className="group-frame__body" />

      <aside className="group-frame__sidebar nodrag">
        <div className="group-frame__sidebar-head">
          <span className="group-frame__sidebar-title">Agentes</span>
          <span className="group-frame__sidebar-count">{agents.length}</span>
        </div>

        <div className="group-frame__level" title="Nível do projeto — sobe conforme o grupo gasta tokens">
          <div className="group-frame__mascot">
            <Mascot level={lvl.level} working={working} size={76} />
          </div>
          <div className="group-frame__level-row">
            <span className="group-frame__level-badge">
              Nv {lvl.level} · {formName(lvl.level)}
            </span>
            <span className="group-frame__level-caption">
              {formatCost(groupTotal.cost_usd)}
              {lvl.nextAt
                ? ` · ${formatTokens(groupTotal.total_tokens)}/${formatTokens(lvl.nextAt)}`
                : " · máx"}
            </span>
          </div>
          <div className="group-frame__level-bar">
            <div
              className="group-frame__level-fill"
              style={{ width: `${Math.round(lvl.progress * 100)}%` }}
            />
          </div>
        </div>
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
                  className="group-frame__agent-edit"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingAgent(a);
                  }}
                  title="Editar instruções do agente"
                  aria-label="Editar agente"
                >
                  ✎
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
        {(groupTotal.total_tokens > 0 || groupTotal.cost_usd > 0) && (
          <div className="group-frame__total" title="Custo estimado e soma de tokens dos terminais abertos deste projeto">
            <span className="group-frame__total-label">Total</span>
            <span className="group-frame__total-value">
              {formatCost(groupTotal.cost_usd)} · {formatTokens(groupTotal.total_tokens)} tok
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
        <button
          type="button"
          className="group-frame__create group-frame__create--ghost"
          onClick={(e) => {
            e.stopPropagation();
            openPlainTerminal();
          }}
          title="Abrir um terminal comum (shell) neste grupo"
        >
          + Terminal
        </button>
      </aside>

      {modalOpen && (
        <CreateAgentModal
          groupId={id}
          defaultColor={nextAgentColor(agents.map((a) => a.color))}
          onClose={() => setModalOpen(false)}
        />
      )}

      {editingAgent && (
        <CreateAgentModal
          groupId={id}
          defaultColor={editingAgent.color}
          agent={editingAgent}
          onClose={() => setEditingAgent(null)}
        />
      )}
    </div>
  );
}

/** Mascot form name for a given level (metamorphosis every 10 levels). */
function formName(level: number): string {
  if (level <= 10) return "Aprendiz";
  if (level <= 20) return "Feiticeiro";
  if (level <= 30) return "Arquimago";
  if (level <= 40) return "Mago Celestial";
  return "Deus Arcano";
}

export const GroupFrame = memo(GroupFrameInner);
GroupFrame.displayName = "GroupFrame";
