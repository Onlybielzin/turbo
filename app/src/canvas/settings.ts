/**
 * Settings store — user-tunable canvas preferences, persisted to localStorage
 * (separate from the canvas node/edge store).
 *
 * - lodZoom: zoom fraction below which terminal bodies collapse to a lightweight
 *   placeholder (LOD). 0.1 = 10% … 1.0 = 100%. Read live by Canvas' onMove.
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/** Bounds for the LOD threshold, matching the canvas minZoom (0.1) / a sane max. */
export const LOD_ZOOM_MIN = 0.1;
export const LOD_ZOOM_MAX = 1.0;
export const LOD_ZOOM_DEFAULT = 0.4;

interface SettingsState {
  /** Zoom fraction below which terminals render as placeholders. */
  lodZoom: number;
  setLodZoom: (v: number) => void;
}

/** Clamp a value into the allowed LOD range (guards bad persisted/user input). */
function clampLodZoom(v: number): number {
  if (!Number.isFinite(v)) return LOD_ZOOM_DEFAULT;
  return Math.min(LOD_ZOOM_MAX, Math.max(LOD_ZOOM_MIN, v));
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      lodZoom: LOD_ZOOM_DEFAULT,
      setLodZoom: (v: number) => set({ lodZoom: clampLodZoom(v) }),
    }),
    {
      name: "turbo-settings",
      storage: createJSONStorage(() => localStorage),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SettingsState>;
        return {
          ...current,
          lodZoom: clampLodZoom(p.lodZoom ?? LOD_ZOOM_DEFAULT),
        };
      },
    }
  )
);
