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

type TerminalNodeProps = NodeProps & { data: TerminalNodeData };

function TerminalNodeInner({ id, data, selected }: TerminalNodeProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const nodeRef = useRef<HTMLDivElement>(null);
  const { removeNode, updateNodeStatus, setPtyId, normalizeGroups, setNodeUsage } =
    useCanvasStore();

  const status: NodeStatus = data.status ?? "running";
  const color = data.color;
  const sessionId = data.sessionId;

  const [usage, setUsage] = useState<UsageReport | null>(null);

  // Poll this terminal's token/cost usage from its pinned Claude session.
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    const tick = async () => {
      try {
        const report = await invoke<UsageReport>("session_usage", { sessionId });
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
  }, [sessionId, id, setNodeUsage]);

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
