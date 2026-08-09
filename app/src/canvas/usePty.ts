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
 * - Renderer: xterm's DOM renderer for every node (sharp + zoom-stable under
 *   ReactFlow's transform:scale()). WebGL was tried but is counter-productive
 *   under WebKitGTK software compositing on this box (see focus/blur note).
 *
 * Design contract: 03-UI-SPEC.md
 * - FitAddon reads offsetWidth/offsetHeight (not getBoundingClientRect) to
 *   avoid wrong cols/rows at non-1.0 zoom (xterm inside CSS transform).
 * - Paint-reduction: PTY output is coalesced to one term.write per animation
 *   frame, and the cursor only blinks while focused — both cut repaint frequency.
 */
import { useEffect, useRef, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { NodeStatus } from "./store";
import { markActivity } from "./activity";

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
  /**
   * When set, this node is a spawned-agent child: skip pty_spawn and render the
   * live output streamed from the backend via `child_output` events for this pty
   * id (read-only). Lets the subagent be visible working on the canvas.
   */
  attachChildPtyId?: number | null;
}

interface UsePtyResult {
  kill: () => void;
  /** Node gained focus → enable cursor blink. */
  focusRenderer: () => void;
  /** Node lost focus → disable cursor blink. */
  blurRenderer: () => void;
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
  attachChildPtyId,
}: UsePtyOptions): UsePtyResult {
  const ptyIdRef = useRef<number | null>(null);
  const disposedRef = useRef(false);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const killRef = useRef<() => void>(() => {});
  const focusRendererRef = useRef<() => void>(() => {});
  const blurRendererRef = useRef<() => void>(() => {});

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
      // Off by default: a blinking cursor repaints forever on EVERY unfocused
      // terminal. focusRenderer() turns it on only for the node in focus.
      cursorBlink: false,
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

    // Renderer: xterm's built-in DOM renderer for every node — sharp and
    // zoom-stable under ReactFlow's transform:scale(). No render addon is loaded.

    // ── Selection fix under ReactFlow zoom ────────────────────────────────
    // ReactFlow zooms the whole canvas with `transform: scale(z)`. xterm maps a
    // pointer position to a cell by dividing the on-screen pixel offset by the
    // UNSCALED css cell size, so at z≠1 the selection lands on the wrong (higher)
    // row/col — the offset grows with distance from the top. We patch the internal
    // MouseService to divide the pointer offset back by the live canvas scale
    // before xterm maps it. Guarded: if xterm internals change, it degrades to the
    // stock (correct-at-100%-only) behaviour instead of throwing.
    const canvasScale = (): number => {
      const vp = host.closest(".react-flow__viewport");
      if (!vp) return 1;
      const t = getComputedStyle(vp).transform;
      if (!t || t === "none") return 1;
      // Parse the scale factor from the computed transform MANUALLY instead of
      // via `new DOMMatrixReadOnly(t)`: the string constructor is unreliable on
      // WebKitGTK (this box's engine) and, when it throws, the old catch swallowed
      // it and returned 1 — making canvasScale always report "no zoom", so the
      // getCoords patch below became a no-op and selection landed on the wrong
      // (higher) row at any zoom≠1. ReactFlow always emits `matrix(a,b,c,d,e,f)`
      // (2D) where `a` is scaleX; matrix3d(...) puts scaleX first too.
      const m = t.match(/matrix(?:3d)?\(([^)]+)\)/);
      if (!m) return 1;
      const a = parseFloat(m[1].split(",")[0]);
      return Number.isFinite(a) && a > 0 ? a : 1;
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ms = (term as any)._core?._mouseService;
      if (ms && typeof ms.getCoords === "function") {
        const origGetCoords = ms.getCoords.bind(ms);
        ms.getCoords = (
          event: MouseEvent,
          element: HTMLElement,
          cols: number,
          rows: number,
          isSelection?: boolean
        ) => {
          const s = canvasScale();
          if (s && s !== 1 && event && typeof event.clientX === "number") {
            const rect = element.getBoundingClientRect();
            const cx = rect.left + (event.clientX - rect.left) / s;
            const cy = rect.top + (event.clientY - rect.top) / s;
            const proxied = new Proxy(event, {
              get(target, prop) {
                if (prop === "clientX") return cx;
                if (prop === "clientY") return cy;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const v = (target as any)[prop];
                return typeof v === "function" ? v.bind(target) : v;
              },
            });
            return origGetCoords(proxied, element, cols, rows, isSelection);
          }
          return origGetCoords(event, element, cols, rows, isSelection);
        };
      }
    } catch {
      /* xterm internals changed — keep stock behaviour */
    }

    // ── Clipboard: copy-on-select + Ctrl+C / Ctrl+V (and Ctrl+Shift+C/V) ──
    // Text selection itself is enabled by the `nodrag`/`nowheel` classes on the
    // body (so dragging selects instead of moving the node). Selecting with the
    // mouse auto-copies; the shortcuts give explicit copy/paste.
    //
    // Ctrl+C is overloaded: in a terminal it normally sends SIGINT to interrupt
    // the process. So plain Ctrl+C only COPIES when there is a selection — and it
    // clears the selection afterwards so a second Ctrl+C falls through as SIGINT
    // (same behaviour as VS Code's integrated terminal). With no selection it is
    // forwarded to the PTY as usual. Ctrl+Shift+C always copies.
    const copySelection = () => {
      if (!term.hasSelection()) return false;
      const sel = term.getSelection();
      if (sel && sel.trim()) {
        void navigator.clipboard.writeText(sel).catch(() => {});
        return true;
      }
      return false;
    };
    const paste = () => {
      // Paste via the Rust backend (wl-paste), NOT navigator.clipboard: WebKitGTK
      // can't hand the webview image bytes and readText() only sees text. pty_paste
      // writes text as-is and, for an image, saves a temp PNG and writes its path
      // (Claude Code attaches images by path). Covers Ctrl+V and Ctrl+Shift+V —
      // which is exactly what the N3X0 manager injects for Super+V via wtype.
      if (ptyIdRef.current !== null)
        void invoke("pty_paste", { id: ptyIdRef.current }).catch(() => {});
    };
    host.addEventListener("mouseup", () => {
      copySelection();
    });
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const isC = e.key === "C" || e.key === "c";
      const isV = e.key === "V" || e.key === "v";
      // Ctrl+Shift+C / Ctrl+Shift+V — explicit copy/paste.
      if (e.ctrlKey && e.shiftKey && isC) {
        copySelection();
        return false; // handled — don't forward to the PTY
      }
      if (e.ctrlKey && e.shiftKey && isV) {
        paste();
        return false;
      }
      // Plain Ctrl+C — copy only if something is selected, then clear it so the
      // next Ctrl+C sends SIGINT. No selection → forward to the PTY (interrupt).
      if (e.ctrlKey && !e.shiftKey && !e.altKey && isC) {
        if (copySelection()) {
          e.preventDefault();
          e.stopPropagation();
          term.clearSelection();
          return false;
        }
        return true;
      }
      // Plain Ctrl+V — paste. (Ctrl+V's readline "verbatim insert" is rarely
      // used and worth trading for a native paste shortcut.)
      if (e.ctrlKey && !e.shiftKey && !e.altKey && isV) {
        paste();
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

    // Coalesce PTY output to a single term.write per animation frame (perf):
    // a chatty agent can fire many small chunks between frames; writing each one
    // triggers its own render/refresh cycle. We buffer the byte arrays and flush
    // them concatenated once per rAF, collapsing N paints into one.
    let pending: number[][] = [];
    let flushHandle: number | null = null;
    const flush = () => {
      flushHandle = null;
      if (pending.length === 0) return;
      let total = 0;
      for (const chunk of pending) total += chunk.length;
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of pending) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      pending = [];
      term.write(merged);
    };

    const onData = new Channel<number[]>();
    onData.onmessage = (bytes) => {
      markActivity(nodeId); // PTY produced output → this agent is actively working
      pending.push(bytes);
      if (flushHandle === null) flushHandle = requestAnimationFrame(flush);
    };

    // Cleanup handle for the child_output listener (spawned-agent child nodes).
    let childOutputUnlisten: (() => void) | null = null;

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
        if (attachChildPtyId != null) {
          // Spawned-agent child: don't spawn a PTY — attach to the live output
          // stream the backend emits for this pty id so the subagent is visible
          // working on the canvas (read-only; no input/resize forwarding).
          ptyId = attachChildPtyId;
          ptyIdRef.current = ptyId;
          onPtyReady?.(ptyId);
          const enc = new TextEncoder();
          const unlisten = await listen<{ pty_id: number; data: string }>(
            "child_output",
            (event) => {
              if (event.payload.pty_id !== attachChildPtyId) return;
              markActivity(nodeId);
              pending.push(Array.from(enc.encode(event.payload.data)));
              if (flushHandle === null) flushHandle = requestAnimationFrame(flush);
            }
          );
          if (disposedRef.current) unlisten();
          else childOutputUnlisten = unlisten;
          return;
        }
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
        // T2: never fit() mid pan/zoom gesture. A fit() can change cols/rows,
        // firing term.onResize → pty_resize → SIGWINCH, making the live agent
        // reflow on every zoom step (catastrophic for perf and correctness). The
        // node's offset box doesn't actually change under transform:scale, so a
        // fit here during a gesture would be spurious anyway. Canvas re-fits once
        // when the gesture settles (data-zooming cleared). Guarded read.
        if (host.closest(".canvas-area[data-zooming]")) return;
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

    // ── Cursor blink on focus / blur ──────────────────────────────────────
    // Every node stays on xterm's DOM renderer. We tried upgrading the focused
    // node to the WebGL addon (GPU glyph rasterization), but under WebKitGTK's
    // SOFTWARE compositing (WEBKIT_DISABLE_DMABUF_RENDERER=1 — forced on this
    // Wayland/NVIDIA box) a WebGL canvas must be read back GPU→CPU every frame to
    // be composited, which added jank/CPU instead of removing it. So the only
    // per-focus behaviour is the cursor blink: on for the focused node, off for
    // all others (an idle blink repaints every unfocused terminal forever).
    focusRendererRef.current = () => {
      const term = termRef.current;
      if (term) term.options.cursorBlink = true;
    };

    blurRendererRef.current = () => {
      const term = termRef.current;
      if (term) term.options.cursorBlink = false;
    };

    // ── Cleanup ───────────────────────────────────────────────────────────
    return () => {
      disposedRef.current = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      if (flushHandle !== null) cancelAnimationFrame(flushHandle);
      resizeObserver.disconnect();
      host.removeEventListener("mouseup", copySelection);

      void unlistenExit.then((f) => f());
      if (childOutputUnlisten) childOutputUnlisten();

      if (ptyIdRef.current !== null) {
        // Kill the PTY regardless of whether we spawned it or attached to an existing one
        void invoke("pty_kill", { id: ptyIdRef.current });
        ptyIdRef.current = null;
      }

      // Tear down xterm DEFENSIVELY. Every step is guarded so cleanup can never
      // throw (a throw here could otherwise unmount the whole React tree).
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
  const focusRenderer = useCallback(() => focusRendererRef.current(), []);
  const blurRenderer = useCallback(() => blurRendererRef.current(), []);

  return { kill, focusRenderer, blurRenderer };
}
