/**
 * TerminalNode — Custom @xyflow/react node that hosts a live xterm.js PTY.
 *
 * Design contract: 03-UI-SPEC.md
 * - Header: 32px, gradient brand-a→brand-b, status dot (8×8px) + label (12px/700) + kill (×)
 * - Body: --panel background, xterm fills flush
 * - Node frame: 1px --node-border, border-radius 6px; focused → --node-border-focused
 * - Kill: no confirmation, fade-out 150ms then remove
 * - Renderer: CanvasAddon default; WebGL on focus; max 1 WebGL context at a time
 * - React.memo to prevent cascata re-render
 */
import { memo, useRef, useCallback, useEffect, useState } from "react";
import { NodeProps, NodeResizer } from "@xyflow/react";
import { invoke } from "@tauri-apps/api/core";
import { useCanvasStore, TerminalNodeData, NodeStatus, UsageReport } from "./store";
import { usePty } from "./usePty";
import { formatTokens, formatCost } from "./usage";
import "@xterm/xterm/css/xterm.css";
import "./TerminalNode.css";

/** One changed file as reported by git_changes. */
interface Change {
  path: string;
  status: string;
  staged: boolean;
}

const MAX_CHIPS = 8;

type TerminalNodeProps = NodeProps & { data: TerminalNodeData };

function TerminalNodeInner({ id, data, selected }: TerminalNodeProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const nodeRef = useRef<HTMLDivElement>(null);
  const { removeNode, updateNodeStatus, setPtyId, normalizeGroups, setNodeUsage, addViewerNode, nodes } =
    useCanvasStore();

  const status: NodeStatus = data.status ?? "running";
  const color = data.color;
  const sessionId = data.sessionId;

  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);

  // Poll git changes in the cwd every 3 seconds to surface artifact chips.
  useEffect(() => {
    if (!data.cwd) return;
    let alive = true;
    const poll = async () => {
      try {
        const result = await invoke<Change[]>("git_changes", { cwd: data.cwd });
        if (alive) setChanges(result);
      } catch {
        // Not a git repo or other error — silently ignore.
        if (alive) setChanges([]);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [data.cwd]);

  // Poll this terminal's token/cost usage. Claude terminals read their pinned
  // session transcript; Codex terminals read the newest ~/.codex rollout for
  // their cwd (Codex ignores --session-id, so we match by working directory).
  const isCodex = data.command === "codex";
  const cwd = data.cwd;
  useEffect(() => {
    if (isCodex ? !cwd : !sessionId) return;
    let alive = true;
    const tick = async () => {
      try {
        const report = isCodex
          ? await invoke<UsageReport>("codex_usage", { cwd })
          : await invoke<UsageReport>("session_usage", { sessionId });
        if (!alive) return;
        setUsage(report);
        setNodeUsage(id, report);
      } catch {
        // ignore — transcript may not exist yet
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [isCodex, cwd, sessionId, id, setNodeUsage]);

  const handleStatusChange = useCallback(
    (s: NodeStatus) => updateNodeStatus(id, s),
    [id, updateNodeStatus]
  );

  const handlePtyReady = useCallback(
    (ptyId: number) => setPtyId(id, ptyId),
    [id, setPtyId]
  );

  const { kill, activateWebGL, deactivateWebGL } = usePty({
    nodeId: id,
    hostRef,
    command: data.command,
    args: data.args as string[] | undefined,
    cwd: data.cwd,
    env: data.env as [string, string][] | undefined,
    onStatusChange: handleStatusChange,
    onPtyReady: handlePtyReady,
    // No existingPtyId needed: create_group no longer pre-spawns claude.
    // usePty always spawns the PTY itself, using env vars for group context.
  });

  const handleKill = useCallback(() => {
    kill();
    // Fade out then remove
    if (nodeRef.current) {
      nodeRef.current.style.transition = "opacity 150ms ease";
      nodeRef.current.style.opacity = "0";
      setTimeout(() => removeNode(id), 150);
    } else {
      removeNode(id);
    }
  }, [kill, removeNode, id]);

  const handleFocus = useCallback(() => {
    activateWebGL();
  }, [activateWebGL]);

  const handleBlur = useCallback(() => {
    deactivateWebGL();
  }, [deactivateWebGL]);

  // Handle chip click: find the group this terminal belongs to and open a viewer.
  const handleChipClick = useCallback(
    (change: Change) => {
      // The parentId of this terminal node is the group id.
      const parentId = nodes.find((n) => n.id === id)?.parentId;
      if (!parentId || !data.cwd) return;
      addViewerNode(parentId, change.path, data.cwd);
    },
    [id, nodes, data.cwd, addViewerNode]
  );

  return (
    <div
      ref={nodeRef}
      className={`terminal-node${selected ? " terminal-node--selected" : ""}${
        color ? " terminal-node--agent" : ""
      }`}
      style={color ? ({ ["--agent-color"]: color } as React.CSSProperties) : undefined}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      {/* Always mounted so the node is always resizable; the handles are shown
          on hover / selection via CSS (xterm can steal the click that would
          otherwise select the node). */}
      <NodeResizer
        minWidth={240}
        minHeight={160}
        isVisible
        onResizeEnd={() => normalizeGroups()}
      />
      <div className="terminal-node__header" data-drag-handle>
        {color ? (
          <span
            className="terminal-node__agent-dot"
            style={{ background: color }}
            aria-hidden
          />
        ) : (
          <span
            className={`terminal-node__status-dot terminal-node__status-dot--${status}`}
            aria-label={statusLabel(status)}
          />
        )}
        <span className="terminal-node__label">{data.label ?? "Terminal"}</span>
        {usage && usage.found && (
          <span
            className="terminal-node__usage"
            title={`entrada ${usage.input_tokens} · saída ${usage.output_tokens} · cache leitura ${usage.cache_read_input_tokens} · cache escrita ${usage.cache_creation_input_tokens}`}
          >
            {formatTokens(usage.total_tokens)} tok · {formatCost(usage.cost_usd)}
          </span>
        )}
        <button
          type="button"
          className="terminal-node__kill"
          onClick={handleKill}
          title="Matar processo"
          aria-label="Matar processo"
        >
          ×
        </button>
      </div>
      {changes.length > 0 && (
        <div className="terminal-node__artifacts nodrag">
          {changes.slice(0, MAX_CHIPS).map((change) => {
            const basename = change.path.replace(/\\/g, "/").split("/").pop() ?? change.path;
            const statusCls =
              change.status === "A" || change.status === "?"
                ? "terminal-node__chip--new"
                : change.status === "D"
                ? "terminal-node__chip--del"
                : "terminal-node__chip--mod";
            return (
              <button
                key={change.path}
                type="button"
                className={`terminal-node__chip ${statusCls}`}
                title={`${change.path} [${change.status}]`}
                onClick={() => handleChipClick(change)}
              >
                {basename}
              </button>
            );
          })}
          {changes.length > MAX_CHIPS && (
            <span className="terminal-node__chip-overflow">
              +{changes.length - MAX_CHIPS}
            </span>
          )}
        </div>
      )}
      <div
        ref={hostRef}
        className="terminal-node__body nodrag nowheel nopan"
        tabIndex={0}
      />
    </div>
  );
}

function statusLabel(status: NodeStatus): string {
  switch (status) {
    case "running": return "rodando";
    case "ok": return "encerrado";
    case "error": return "erro";
  }
}

export const TerminalNode = memo(TerminalNodeInner);
TerminalNode.displayName = "TerminalNode";
