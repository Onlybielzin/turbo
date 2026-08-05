/**
 * usePty — Reusable hook that manages the full PTY lifecycle for a TerminalNode.
 *
 * Responsibilities:
 * - Spawn a PTY via Tauri `pty_spawn` with optional cwd and command
 * - Stream bytes from Rust Channel → xterm.js
 * - Forward keyboard input from xterm → PTY
 * - Send SIGWINCH on terminal resize (debounced 16ms)
 * - Track process status (running / ok / error)
 * - Kill PTY on unmount or when kill() is called
 * - Handle pty_exit event to update status
 * - Renderer switching: CanvasAddon by default; WebGL on focus (max 1 active)
 *
 * Design contract: 03-UI-SPEC.md
 * - FitAddon reads offsetWidth/offsetHeight (not getBoundingClientRect) to
 *   avoid wrong cols/rows at non-1.0 zoom (xterm inside CSS transform).
 * - Max 1 WebGL context active at any time (addon-canvas for all others).
 */
import { useEffect, useRef, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { NodeStatus } from "./store";

// Singleton: track which node currently has the WebGL renderer.
// We use a module-level variable so all TerminalNode instances share it.
let webGLFocusedNodeId: string | null = null;

interface UsePtyOptions {
  nodeId: string;
  hostRef: React.RefObject<HTMLDivElement | null>;
  command?: string;
  args?: string[];
  cwd?: string;
  onStatusChange?: (status: NodeStatus) => void;
  onPtyReady?: (ptyId: number) => void;
}

interface UsePtyResult {
  kill: () => void;
  activateWebGL: () => void;
  deactivateWebGL: () => void;
}

export function usePty({
  nodeId,
  hostRef,
  command,
  args,
  cwd,
  onStatusChange,
  onPtyReady,
}: UsePtyOptions): UsePtyResult {
  const ptyIdRef = useRef<number | null>(null);
  const disposedRef = useRef(false);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const canvasAddonRef = useRef<CanvasAddon | null>(null);
  // Store WebGL addon class dynamically to avoid bundling it if never used
  const webGLAddonRef = useRef<InstanceType<typeof import("@xterm/addon-webgl").WebglAddon> | null>(null);

  const killRef = useRef<() => void>(() => {});
  const activateWebGLRef = useRef<() => void>(() => {});
  const deactivateWebGLRef = useRef<() => void>(() => {});

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      fontFamily: 'ui-monospace, "JetBrains Mono", "Fira Code", Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: {
        background: "#161514",
        foreground: "#e6e1dc",
        cursor: "#c9433a",
      },
    });
    termRef.current = term;

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(host);

    // Default renderer: CanvasAddon (not WebGL — limit to 1 WebGL context)
    const canvasAddon = new CanvasAddon();
    canvasAddonRef.current = canvasAddon;
    term.loadAddon(canvasAddon);

    // Fit after renderer is attached. Use offsetWidth/offsetHeight so we get
    // pre-transform dimensions (correct when ReactFlow zooms the canvas).
    try {
      fit.fit();
    } catch {
      /* element not measurable yet */
    }

    // ── PTY spawn ──────────────────────────────────────────────────────────
    let ptyId: number | null = null;

    const onData = new Channel<number[]>();
    onData.onmessage = (bytes) => term.write(new Uint8Array(bytes));

    void (async () => {
      const spawnPty = async (cmd?: string, cmdArgs?: string[]) => {
        const spawnArgs: Record<string, unknown> = {
          cols: term.cols,
          rows: term.rows,
          onData,
        };
        if (cmd) spawnArgs.command = cmd;
        if (cmdArgs) spawnArgs.args = cmdArgs;
        if (cwd) spawnArgs.cwd = cwd;
        return invoke<number>("pty_spawn", spawnArgs);
      };

      try {
        try {
          ptyId = await spawnPty(command, args);
        } catch (spawnErr) {
          // If the requested command wasn't found, fall back to the default shell
          if (command && String(spawnErr).toLowerCase().includes("no such file")) {
            term.writeln(
              `\r\n\x1b[90m[claude não encontrado no PATH — abrindo shell]\x1b[0m`
            );
            ptyId = await spawnPty(); // spawn default shell
          } else {
            throw spawnErr;
          }
        }

        ptyIdRef.current = ptyId;
        if (disposedRef.current) {
          void invoke("pty_kill", { id: ptyId });
          return;
        }
        onPtyReady?.(ptyId);

        term.onData((d) => {
          if (ptyIdRef.current !== null)
            void invoke("pty_write", { id: ptyIdRef.current, data: d });
        });
        term.onResize(({ cols, rows }) => {
          if (ptyIdRef.current !== null)
            void invoke("pty_resize", { id: ptyIdRef.current, cols, rows });
        });
      } catch (err) {
        term.writeln(`\r\n\x1b[31m[falha ao iniciar pty: ${String(err)}]\x1b[0m`);
        onStatusChange?.("error");
      }
    })();

    // ── Resize observer (debounced 16ms) ──────────────────────────────────
    // FitAddon must read offsetWidth/offsetHeight (not getBoundingClientRect)
    // because ReactFlow applies a CSS transform:scale() during zoom — reading
    // BoundingClientRect would return scaled dimensions and produce wrong cols/rows.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        try {
          fit.fit();
        } catch {
          /* element not measurable */
        }
      }, 16);
    });
    resizeObserver.observe(host);

    // ── pty_exit event ────────────────────────────────────────────────────
    // Rust emits: app.emit("pty_exit", id) where id is u32
    const unlistenExit = listen<number>("pty_exit", (event) => {
      const exitId = event.payload;
      if (exitId !== ptyIdRef.current) return;
      term.writeln("\r\n\x1b[90m[processo encerrado]\x1b[0m");
      onStatusChange?.("ok");
    });


    // ── Kill function ─────────────────────────────────────────────────────
    killRef.current = () => {
      if (ptyIdRef.current !== null) {
        void invoke("pty_kill", { id: ptyIdRef.current });
        ptyIdRef.current = null;
      }
    };

    // ── WebGL renderer switching ──────────────────────────────────────────
    activateWebGLRef.current = () => {
      if (webGLFocusedNodeId === nodeId) return; // already active
      // If another node has WebGL, do nothing (they will deactivate on blur)
      if (webGLFocusedNodeId !== null) return;

      void import("@xterm/addon-webgl").then(({ WebglAddon }) => {
        if (webGLFocusedNodeId !== null || !termRef.current) return;
        try {
          // Detach canvas addon
          if (canvasAddonRef.current) {
            // CanvasAddon has no dispose method — we recreate on switch back
            // Actually canvasAddon.dispose() should work in newer builds
            canvasAddonRef.current.dispose?.();
            canvasAddonRef.current = null;
          }
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => {
            // Fallback to canvas on context loss
            deactivateWebGLRef.current();
          });
          termRef.current.loadAddon(webgl);
          webGLAddonRef.current = webgl;
          webGLFocusedNodeId = nodeId;
        } catch {
          // WebGL not available — stay on canvas renderer
        }
      });
    };

    deactivateWebGLRef.current = () => {
      if (webGLFocusedNodeId !== nodeId) return;
      if (webGLAddonRef.current) {
        try {
          webGLAddonRef.current.dispose?.();
        } catch {
          /* ignore */
        }
        webGLAddonRef.current = null;
      }
      webGLFocusedNodeId = null;
      // Reattach canvas renderer
      if (termRef.current) {
        const ca = new CanvasAddon();
        canvasAddonRef.current = ca;
        try {
          termRef.current.loadAddon(ca);
        } catch {
          /* ignore */
        }
      }
    };

    // ── Cleanup ───────────────────────────────────────────────────────────
    return () => {
      disposedRef.current = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeObserver.disconnect();

      void unlistenExit.then((f) => f());

      // Deactivate WebGL if this node had it
      if (webGLFocusedNodeId === nodeId) {
        deactivateWebGLRef.current();
      }

      if (ptyIdRef.current !== null) {
        void invoke("pty_kill", { id: ptyIdRef.current });
        ptyIdRef.current = null;
      }
      term.dispose();
      termRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — runs once on mount

  const kill = useCallback(() => killRef.current(), []);
  const activateWebGL = useCallback(() => activateWebGLRef.current(), []);
  const deactivateWebGL = useCallback(() => deactivateWebGLRef.current(), []);

  return { kill, activateWebGL, deactivateWebGL };
}
