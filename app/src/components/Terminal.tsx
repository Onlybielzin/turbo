import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

/**
 * A live terminal node bound to a backend PTY.
 *
 * Phase 1 proves the round-trip: spawn a shell, stream its bytes into xterm
 * (canvas renderer — WebGL is reserved for the focused node in Phase 3),
 * forward keyboard input, and keep the PTY sized to the element via FitAddon.
 */
export function Terminal() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      fontFamily:
        'ui-monospace, "JetBrains Mono", "Fira Code", Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: {
        background: "#161514",
        foreground: "#e6e1dc",
        cursor: "#c9433a",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    term.loadAddon(new CanvasAddon());
    fit.fit();

    let ptyId: number | null = null;
    let disposed = false;

    // Rust streams raw bytes; xterm decodes UTF-8 across chunk boundaries.
    const onData = new Channel<number[]>();
    onData.onmessage = (bytes) => term.write(new Uint8Array(bytes));

    void (async () => {
      try {
        ptyId = await invoke<number>("pty_spawn", {
          cols: term.cols,
          rows: term.rows,
          onData,
        });
        if (disposed) {
          void invoke("pty_kill", { id: ptyId });
          return;
        }
        term.onData((d) => {
          if (ptyId !== null) void invoke("pty_write", { id: ptyId, data: d });
        });
        term.onResize(({ cols, rows }) => {
          if (ptyId !== null) void invoke("pty_resize", { id: ptyId, cols, rows });
        });
      } catch (err) {
        term.writeln(`\r\n[failed to start pty: ${String(err)}]`);
      }
    })();

    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* element not measurable yet */
      }
    });
    resizeObserver.observe(host);

    const unlisten = listen<number>("pty_exit", (event) => {
      if (event.payload === ptyId) term.writeln("\r\n\x1b[90m[process exited]\x1b[0m");
    });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      void unlisten.then((f) => f());
      if (ptyId !== null) void invoke("pty_kill", { id: ptyId });
      term.dispose();
    };
  }, []);

  return <div ref={hostRef} className="terminal-host" />;
}
