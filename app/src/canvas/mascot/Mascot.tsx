/**
 * Mascot — the group's evolving pixel wizard, shown on the level card.
 *
 * States:
 *  - working=true  → the level's "channeling" idle (magic scales with level).
 *  - working=false → cycles the cozy REST idles (breathe, coffee, cat, dragon
 *    egg, nap).
 *  - evolving      → on crossing a form boundary (every 10 levels) plays the
 *    one-shot transformation, then settles into the new form's idle.
 *
 * Idles play in PING-PONG (0→last→0) for a seamless loop; the evolution plays
 * forward once and holds the last frame until it ends.
 */
import { useEffect, useRef, useState } from "react";
import {
  workSheet,
  restSheets,
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
const REST_SWITCH_MS = 7000;
const EVOLVE_MS = 1600;

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

  // Advance the REST animation by WALL-CLOCK time so it keeps cycling even
  // though GroupFrame re-renders (token polling) would reset a plain counter.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => (x + 1) % 1_000_000), 1000);
    return () => clearInterval(t);
  }, []);
  const rest = restSheets(formIndex(level));
  const restIdx = Math.floor(Date.now() / REST_SWITCH_MS) % rest.length;

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
  const sheet = evolveSrc ?? (working ? workSheet(level) : rest[restIdx % rest.length]);

  // Frame ticker: ping-pong for idles, forward-once for the evolution.
  const [frame, setFrame] = useState(0);
  const dir = useRef(1);
  useEffect(() => {
    setFrame(0);
    dir.current = 1;
    // Off-screen, or frozen (mid pan/zoom gesture / far-zoom LOD), and not
    // mid-evolution → don't repaint. The rare one-shot evolution always plays
    // (it's short); the ticker resumes when visible/unfrozen again.
    if ((!visible || frozen) && !oneShot) return;
    const t = setInterval(() => {
      setFrame((f) => {
        if (oneShot) return Math.min(f + 1, FRAME_COUNT - 1);
        let nf = f + dir.current;
        if (nf >= FRAME_COUNT - 1) {
          nf = FRAME_COUNT - 1;
          dir.current = -1;
        } else if (nf <= 0) {
          nf = 0;
          dir.current = 1;
        }
        return nf;
      });
    }, 1000 / FPS);
    return () => clearInterval(t);
  }, [sheet, oneShot, visible, frozen]);

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
