/**
 * ErrorBoundary — catches render/lifecycle errors in its subtree and shows the
 * error instead of unmounting the whole React tree (which blanks the webview to
 * the dark body background, looking like a "black screen").
 *
 * React error boundaries must be class components (React 19 has no hook form).
 */
import { Component, ReactNode, ErrorInfo } from "react";

interface Props {
  children: ReactNode;
  /** Short label shown in the fallback so we know which boundary caught it. */
  label?: string;
  /** When true, render a compact inline fallback (for a single node). */
  compact?: boolean;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Also log to the devtools console for good measure.
    // eslint-disable-next-line no-console
    console.error(`[Turbo ErrorBoundary${this.props.label ? " " + this.props.label : ""}]`, error, info);
    this.setState({ info });
  }

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          padding: this.props.compact ? "8px 10px" : "24px",
          margin: this.props.compact ? 0 : "24px",
          fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, monospace',
          fontSize: 12,
          lineHeight: 1.5,
          color: "#e6e1dc",
          background: "#161514",
          border: "1px solid #c9433a",
          borderRadius: 8,
          maxHeight: this.props.compact ? 220 : "80vh",
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        <strong style={{ color: "#c9433a" }}>
          Erro{this.props.label ? ` em ${this.props.label}` : ""}: {error.name}
        </strong>
        {"\n"}
        {error.message}
        {error.stack ? "\n\n" + error.stack : ""}
        {info?.componentStack ? "\n\nComponent stack:" + info.componentStack : ""}
      </div>
    );
  }
}
