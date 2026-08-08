/**
 * FpsMeter — tiny always-on HUD showing the live frame rate of the canvas.
 *
 * Measures via requestAnimationFrame and writes STRAIGHT to the DOM (textContent
 * + color) roughly twice a second, without any React state — so the meter itself
 * triggers no re-render and adds no paint beyond redrawing its own little pill.
 * Colour: green ≥ 55 fps, amber ≥ 30, red below.
 */
import { useEffect, useRef } from "react";

const GOOD_FPS = 55;
const OK_FPS = 30;
const SAMPLE_MS = 500;

export function FpsMeter() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let last = performance.now();

    const tick = (now: number) => {
      frames++;
      const elapsed = now - last;
      if (elapsed >= SAMPLE_MS) {
        const fps = Math.round((frames * 1000) / elapsed);
        const el = ref.current;
        if (el) {
          el.textContent = `${fps} fps`;
          el.style.color =
            fps >= GOOD_FPS ? "#51cf66" : fps >= OK_FPS ? "#ffd43b" : "#ff6b6b";
        }
        frames = 0;
        last = now;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="fps-indicator" aria-hidden="true" ref={ref}>
      — fps
    </div>
  );
}
