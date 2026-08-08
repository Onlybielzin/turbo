/**
 * Mascot — the group's evolving pixel wizard, shown on the level card.
 *
 * States:
 *  - working=true  → cycles the WORK ("channeling") idles of EVERY level
 *    reached within the current tier (nv1..nv9 at level 9, nv11..nv19 at 19).
 *  - working=false → cycles those same tier idles plus the form's cozy REST
 *    idles (breathe, coffee, cat, dragon egg, nap, …).
 *  - evolving      → on crossing a form boundary (every 10 levels) plays the
 *    one-shot transformation, then settles into the new tier's pool. The
 *    evolution sheet is NEVER part of the normal loop.
 *
 * Idles play in PING-PONG (0→last→0) for a seamless loop. The animation is
 * only swapped for another one from the pool at the END of a ping-pong cycle
 * (frame back at 0), so there is no visible restart / jump mid-animation. The
 * evolution plays forward once and holds the last frame until it ends.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  workPool,
  restPool,
  evolveSheet,
  formIndex,
  FRAME_W,
  FRAME_H,
  FRAME_COUNT,
} from "./mascotAssets";
import "./Mascot.css";

interface MascotProps {
  /** Current group level (1..50). */
  level: number;
  /** True when at least one agent/terminal is running in the group. */
  working?: boolean;
  /** Rendered box size in px (square). Default 76. */
  size?: number;
}

const FPS = 12;
const EVOLVE_MS = 1600;
/** How many full ping-pong cycles a sheet plays before swapping to another. */
const LOOPS_BEFORE_SWITCH = 2;

export function Mascot({ level, working = false, size = 76 }: MascotProps) {
  // Pause the frame ticker while the mascot is scrolled off-screen — otherwise
  // its sprite repaints at FPS forever on every group card, even ones nobody can
  // see. An IntersectionObserver flips `visible`; the ticker keys off it.
  const rootRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { root: null }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Freeze the sprite while the canvas is mid pan/zoom gesture ([data-zooming])
  // or collapsed to far-zoom LOD ([data-lod-far]) — the same states that swap
  // terminals to their cheap placeholder. A 12fps sprite repainting on every
  // group card during a zoom gesture is exactly the paint we're cutting; CSS
  // also hides the sprite in these states (see Mascot.css) so it doesn't
  // re-rasterize under transform:scale, mirroring the terminal body.
  const [frozen, setFrozen] = useState(false);
  useEffect(() => {
    const area = rootRef.current?.closest(".canvas-area");
    if (!area) return;
    const read = () =>
      setFrozen(
        area.hasAttribute("data-zooming") || area.hasAttribute("data-lod-far")
      );
    read();
    const mo = new MutationObserver(read);
    mo.observe(area, {
      attributes: true,
      attributeFilter: ["data-zooming", "data-lod-far"],
    });
    return () => mo.disconnect();
  }, []);

  // One-shot evolution when the form changes (level crosses a x0→x1 boundary).
  const [evolveSrc, setEvolveSrc] = useState<string | null>(null);
  const prevLevel = useRef(Math.floor(level) || 1);
  useEffect(() => {
    const lv = Math.floor(level) || 1;
    if (lv > prevLevel.current && formIndex(lv) > formIndex(prevLevel.current)) {
      const s = evolveSheet(formIndex(lv));
      prevLevel.current = lv;
      if (s) {
        setEvolveSrc(s);
        const t = setTimeout(() => setEvolveSrc(null), EVOLVE_MS);
        return () => clearTimeout(t);
      }
    } else {
      prevLevel.current = lv;
    }
  }, [level]);
  const oneShot = evolveSrc !== null;

  // Pool of sheets to cycle for the current state. WORK and REST both cycle the
  // tier's level idles; REST also folds in the form's cozy idles. Kept in a ref
  // so the frame ticker always reads the latest pool (e.g. a newly reached
  // level enters the rotation) without the ticker restarting.
  const pool = useMemo<readonly string[]>(() => {
    if (evolveSrc) return [evolveSrc];
    return working ? workPool(level) : restPool(level);
  }, [evolveSrc, working, level]);
  const poolRef = useRef(pool);
  poolRef.current = pool;

  // The sheet currently playing.
  const [sheet, setSheet] = useState<string>(() => pool[0]);

  // On a real mode change (start/stop working) switch to the new pool without
  // touching the frame, so the current idle flows into the next one seamlessly.
  useEffect(() => {
    if (!poolRef.current.includes(sheet)) setSheet(poolRef.current[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [working]);

  // Frame ticker: ping-pong for idles, forward-once for the evolution. It never
  // depends on `sheet`, so a swap only ever happens at frame 0 (the natural end
  // of a ping-pong cycle) → no visible restart.
  const [frame, setFrame] = useState(0);
  const dir = useRef(1);
  const loops = useRef(0);

  // Enter/exit evolution: start a clean forward pass on the right sheet.
  useEffect(() => {
    setFrame(0);
    dir.current = 1;
    loops.current = 0;
    setSheet(evolveSrc ?? poolRef.current[0]);
  }, [evolveSrc]);

  useEffect(() => {
    // Off-screen, or frozen (mid pan/zoom gesture / far-zoom LOD), and not
    // mid-evolution → don't repaint. The rare one-shot evolution always plays
    // (it's short); the ticker resumes when visible/unfrozen again.
    if ((!visible || frozen) && !oneShot) return;
    const id = setInterval(() => {
      setFrame((f) => {
        if (oneShot) return Math.min(f + 1, FRAME_COUNT - 1);
        let nf = f + dir.current;
        if (nf >= FRAME_COUNT - 1) {
          nf = FRAME_COUNT - 1;
          dir.current = -1;
        } else if (nf <= 0) {
          // Completed a full ping-pong cycle (back at frame 0): the safe point
          // to swap in another sheet without a visible jump.
          nf = 0;
          dir.current = 1;
          loops.current += 1;
          if (loops.current >= LOOPS_BEFORE_SWITCH) {
            loops.current = 0;
            const p = poolRef.current;
            if (p.length > 1) {
              setSheet((cur) => {
                let next = cur;
                for (let i = 0; i < 8 && next === cur; i++) {
                  next = p[Math.floor(Math.random() * p.length)];
                }
                return next;
              });
            }
          }
        }
        return nf;
      });
    }, 1000 / FPS);
    return () => clearInterval(id);
  }, [oneShot, visible, frozen]);

  const scale = size / FRAME_H;

  return (
    <div
      ref={rootRef}
      className={`turbo-mascot${oneShot ? " turbo-mascot--evolving" : ""}`}
      style={{ width: size, height: size }}
      title={`Turbo — Nível ${level}${working ? " (trabalhando)" : ""}`}
      aria-label={`Mascote Turbo, nível ${level}`}
    >
      <div
        className="turbo-mascot__view"
        style={{
          width: FRAME_W,
          height: FRAME_H,
          transform: `scale(${scale})`,
          backgroundImage: `url(${sheet})`,
          backgroundPosition: `${-frame * FRAME_W}px 0`,
        }}
      />
    </div>
  );
}
