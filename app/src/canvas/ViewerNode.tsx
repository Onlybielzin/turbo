/**
 * ViewerNode — @xyflow/react node that shows the current content of a file
 * produced by an agent, with a toggle to see the git diff.
 *
 * - mode "view": renders .md files via react-markdown, raw text via <pre>
 * - mode "diff": shows unified diff with line-level colorization
 *
 * Invokes `git_file_view` on mount and on explicit refresh.
 */
import { memo, useCallback, useEffect, useState } from "react";
import { NodeProps, NodeResizer } from "@xyflow/react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import { useCanvasStore, ViewerNodeData } from "./store";
import "./ViewerNode.css";

interface FileView {
  content: string;
  diff: string;
  is_binary: boolean;
}

type Mode = "view" | "diff";

type ViewerNodeProps = NodeProps & { data: ViewerNodeData };

function ViewerNodeInner({ id, data, selected }: ViewerNodeProps) {
  const { removeNode } = useCanvasStore();
  const [mode, setMode] = useState<Mode>("view");
  const [view, setView] = useState<FileView | null>(null);
  const [loading, setLoading] = useState(false);

  const isMarkdown = data.filePath.toLowerCase().endsWith(".md");

  const fetchView = useCallback(async () => {
    if (!data.cwd || !data.filePath) return;
    setLoading(true);
    try {
      const result = await invoke<FileView>("git_file_view", {
        cwd: data.cwd,
        path: data.filePath,
      });
      setView(result);
    } catch {
      // Silently ignore — file may not be accessible yet.
    } finally {
      setLoading(false);
    }
  }, [data.cwd, data.filePath]);

  // Fetch on mount.
  useEffect(() => {
    void fetchView();
  }, [fetchView]);

  const handleClose = useCallback(() => {
    removeNode(id);
  }, [removeNode, id]);

  const handleRefresh = useCallback(() => {
    void fetchView();
  }, [fetchView]);

  // Render the body content depending on mode.
  function renderBody() {
    if (loading) {
      return <div className="viewer-node__loading">Carregando...</div>;
    }
    if (!view) {
      return <div className="viewer-node__loading">Aguardando arquivo...</div>;
    }

    if (mode === "diff") {
      if (!view.diff) {
        return (
          <div className="viewer-node__no-diff">
            <p className="viewer-node__no-diff-msg">
              Sem diff (arquivo novo ou sem alterações rastreadas).
            </p>
            {!view.is_binary && view.content && (
              <pre className="viewer-node__pre">{view.content}</pre>
            )}
          </div>
        );
      }
      return <DiffView diff={view.diff} />;
    }

    // mode === "view"
    if (view.is_binary) {
      return (
        <div className="viewer-node__binary">
          <span className="viewer-node__binary-label">Arquivo binário</span>
        </div>
      );
    }
    if (isMarkdown && view.content) {
      return (
        <div className="viewer-node__markdown">
          <ReactMarkdown>{view.content}</ReactMarkdown>
        </div>
      );
    }
    return <pre className="viewer-node__pre">{view.content}</pre>;
  }

  return (
    <div
      className={`viewer-node${selected ? " viewer-node--selected" : ""}`}
    >
      <NodeResizer minWidth={320} minHeight={240} isVisible />
      <div className="viewer-node__header nodrag">
        <span className="viewer-node__file-icon">&#128196;</span>
        <span className="viewer-node__label" title={data.filePath}>
          {data.label}
        </span>
        <div className="viewer-node__controls">
          <button
            type="button"
            className={`viewer-node__mode-btn${mode === "view" ? " viewer-node__mode-btn--active" : ""}`}
            onClick={() => setMode("view")}
            title="Ver conteudo"
            aria-pressed={mode === "view"}
          >
            Ver
          </button>
          <button
            type="button"
            className={`viewer-node__mode-btn${mode === "diff" ? " viewer-node__mode-btn--active" : ""}`}
            onClick={() => setMode("diff")}
            title="Ver diff"
            aria-pressed={mode === "diff"}
          >
            Diff
          </button>
          <button
            type="button"
            className="viewer-node__refresh"
            onClick={handleRefresh}
            title="Atualizar"
            aria-label="Atualizar arquivo"
          >
            &#8635;
          </button>
          <button
            type="button"
            className="viewer-node__close"
            onClick={handleClose}
            title="Fechar"
            aria-label="Fechar viewer"
          >
            &#x2715;
          </button>
        </div>
      </div>
      <div className="viewer-node__body nowheel nodrag nopan">
        {renderBody()}
      </div>
    </div>
  );
}

/** Renders a unified diff with line-level colorization. */
function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <pre className="viewer-node__diff">
      {lines.map((line, i) => {
        let cls = "";
        if (line.startsWith("+") && !line.startsWith("+++")) {
          cls = "diff-add";
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          cls = "diff-del";
        } else if (line.startsWith("@@")) {
          cls = "diff-hunk";
        }
        return (
          <span key={i} className={cls || undefined}>
            {line}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

export const ViewerNode = memo(ViewerNodeInner);
ViewerNode.displayName = "ViewerNode";
