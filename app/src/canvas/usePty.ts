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
import { markActivity } from "./activity";

// Singleton: track which node currently has the WebGL renderer.
// We use a module-level variable so all TerminalNode instances share it.
let webGLFocusedNodeId: string | null = null;

interface UsePtyOptions {
  nodeId: string;
  hostRef: React.RefObject<HTMLDivElement | null>;
  command?: string;
  args?: string[];
  cwd?: string;
  /** Extra env vars injected into the spawned PTY process (e.g. TURBO_GROUP_ID). */
  env?: [string, string][];
  onStatusChange?: (status: NodeStatus) => void;
  onPtyReady?: (ptyId: number) => void;
  /**
   * When set, skip pty_spawn and attach directly to this existing PTY session.
   * Used by nodes created via create_group (parent agents) where the PTY is
   * already running — prevents the duplicate-spawn bug.
   */
  existingPtyId?: number | null;
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
  env,
  onStatusChange,
  onPtyReady,
  existingPtyId,
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

    // Reset the disposed flag on every (re)mount. React StrictMode in dev runs
    // setup → cleanup → setup on the SAME hook instance; without this reset the
    // second setup would see `disposedRef.current === true` (leftover from the
    // first cleanup) and immediately kill its freshly-spawned PTY — the process
    // appeared to exit instantly ("[processo encerrado]").
    disposedRef.current = false;

    const term = new XTerm({
      // Use the ACTUAL installed font name. The system has "JetBrainsMono Nerd
      // Font Mono" (single-cell-width variant), NOT "JetBrains Mono" — the old
      // family matched nothing and fell back to a wide generic monospace, which
      // is why glyphs looked spaced-out / ugly.
      fontFamily:
        '"JetBrainsMono Nerd Font Mono", "JetBrainsMono NFM", "JetBrainsMono Nerd Font", ui-monospace, monospace',
      fontSize: 14,
      lineHeight: 1.0,
      letterSpacing: 0,
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

    // Renderer: xterm's built-in DOM renderer (no Canvas/WebGL addon). ReactFlow
    // applies transform:scale() to the whole canvas for pan/zoom; the DOM renderer
    // stays crisp under that scale (the browser re-rasterises vector glyphs),
    // whereas a Canvas/WebGL bitmap gets resampled into blurry, oddly-spaced text
    // when zoomed. For a handful of terminals the DOM renderer's perf is plenty.

    // ── Clipboard: copy-on-select + Ctrl+Shift+C (copy) / Ctrl+Shift+V (paste) ──
    // Text selection itself is enabled by the `nodrag`/`nowheel` classes on the
    // body (so dragging selects instead of moving the node). Selecting with the
    // mouse auto-copies; the shortcuts give explicit copy/paste.
    const copySelection = () => {
      const sel = term.getSelection();
      if (sel && sel.trim()) void navigator.clipboard.writeText(sel).catch(() => {});
    };
    host.addEventListener("mouseup", copySelection);
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (e.ctrlKey && e.shiftKey && (e.key === "C" || e.key === "c")) {
        copySelection();
        return false; // handled — don't forward to the PTY
      }
      if (e.ctrlKey && e.shiftKey && (e.key === "V" || e.key === "v")) {
        void navigator.clipboard
          .readText()
          .then((t) => {
            if (t && ptyIdRef.current !== null)
              void invoke("pty_write", { id: ptyIdRef.current, data: t });
          })
          .catch(() => {});
        return false;
      }
      return true;
    });

    // Fit after renderer is attached. Use offsetWidth/offsetHeight so we get
    // pre-transform dimensions (correct when ReactFlow zooms the canvas).
    try {
      fit.fit();
    } catch {
      /* element not measurable yet */
    }

    // ── PTY spawn (or attach to existing) ────────────────────────────────
    let ptyId: number | null = null;

    const onData = new Channel<number[]>();
    onData.onmessage = (bytes) => {
      markActivity(nodeId); // PTY produced output → this agent is actively working
      term.write(new Uint8Array(bytes));
    };

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
        if (env && env.length > 0) spawnArgs.env = env;
        return invoke<number>("pty_spawn", spawnArgs);
      };

      try {
        if (existingPtyId != null) {
          // Attach to the already-running PTY (e.g. parent agent from create_group).
          // We open a new output channel from the existing session so xterm renders output.
          ptyId = existingPtyId;
          try {
            await invoke("pty_attach_channel", { id: ptyId, onData });
          } catch {
            // pty_attach_channel not yet implemented — no-op; output already
            // streams via the channel created inside create_group.
          }
        } else {
          try {
            ptyId = await spawnPty(command, args);
          } catch (spawnErr) {
            // If the requested command wasn't found, fall back to the default shell.
            // Match both the Unix ("no such file") and Windows ("cannot find the
            // file specified" / "program not found") not-found error messages so an
            // uninstalled agent CLI opens a plain shell instead of erroring out.
            const errText = String(spawnErr).toLowerCase();
            const notFound =
              errText.includes("no such file") ||
              errText.includes("cannot find") ||
              errText.includes("not found") ||
              errText.includes("os error 2");
            if (command && notFound) {
              term.writeln(
                `\r\n\x1b[90m[${command} não encontrado no PATH — abrindo shell]\x1b[0m`
              );
              ptyId = await spawnPty(); // spawn default shell
            } else {
              throw spawnErr;
            }
          }
        }

        ptyIdRef.current = ptyId;
        if (disposedRef.current) {
          if (existingPtyId == null) {
            // Only kill if we spawned this PTY ourselves
            void invoke("pty_kill", { id: ptyId });
          }
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
    const isExternalPty = existingPtyId != null;
    killRef.current = () => {
      if (ptyIdRef.current !== null) {
        // Always kill — both self-spawned and externally-created PTYs can be killed
        void invoke("pty_kill", { id: ptyIdRef.current });
        ptyIdRef.current = null;
      }
    };
    void isExternalPty; // suppress unused warning

    // ── WebGL renderer switching ──────────────────────────────────────────
    // Renderer switching disabled: keep the crisp DOM renderer at all times.
    // Canvas/WebGL render to a bitmap that ReactFlow's zoom transform resamples
    // into blurry text; DOM text stays sharp at any zoom. No-op so TerminalNode's
    // focus handler stays valid.
    activateWebGLRef.current = () => {};

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
      host.removeEventListener("mouseup", copySelection);

      void unlistenExit.then((f) => f());

      // Deactivate WebGL if this node had it
      if (webGLFocusedNodeId === nodeId) {
        deactivateWebGLRef.current();
      }

      if (ptyIdRef.current !== null) {
        // Kill the PTY regardless of whether we spawned it or attached to an existing one
        void invoke("pty_kill", { id: ptyIdRef.current });
        ptyIdRef.current = null;
      }

      // Tear down xterm DEFENSIVELY. @xterm/addon-canvas 0.7 on xterm 6 throws in
      // its dispose path (reads a disposed `_linkifier2`) when the terminal disposes
      // the addon mid-teardown — that uncaught throw used to unmount the whole React
      // tree (the "black screen" on group creation, and would also fire on node kill
      // in production). Dispose the render addon FIRST, while the terminal is still
      // alive (so the renderer can reset to DOM cleanly), then dispose the terminal.
      // Every step is guarded so cleanup can never throw.
      try {
        canvasAddonRef.current?.dispose?.();
      } catch {
        /* addon-canvas dispose bug — safe to ignore, terminal is going away */
      }
      canvasAddonRef.current = null;
      try {
        webGLAddonRef.current?.dispose?.();
      } catch {
        /* ignore */
      }
      webGLAddonRef.current = null;
      try {
        term.dispose();
      } catch {
        /* xterm can still throw during internal addon teardown — swallow it */
      }
      termRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — runs once on mount

  const kill = useCallback(() => killRef.current(), []);
  const activateWebGL = useCallback(() => activateWebGLRef.current(), []);
  const deactivateWebGL = useCallback(() => deactivateWebGLRef.current(), []);

  return { kill, activateWebGL, deactivateWebGL };
}
