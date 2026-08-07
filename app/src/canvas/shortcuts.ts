/**
 * Shortcuts store — user-remappable keyboard shortcuts, persisted to localStorage.
 *
 * Only the group-navigation shortcuts are rebindable here (the ones handled in
 * GroupTabs). Terminal copy/paste (Ctrl+Shift+C/V) and jump-to-group (Ctrl+1..9)
 * stay fixed. Handlers read bindings live via useShortcutsStore.getState().
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type ShortcutAction = "autoGrid" | "nextGroup" | "prevGroup";

export interface KeyBinding {
  key: string; // KeyboardEvent.key, e.g. "g", "Tab"
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

export interface ShortcutMeta {
  id: ShortcutAction;
  label: string;
}

/** Rebindable actions, in display order. */
export const SHORTCUT_ACTIONS: ShortcutMeta[] = [
  { id: "autoGrid", label: "Organizar grupos em grade (Auto-grid)" },
  { id: "nextGroup", label: "Ir para o próximo grupo" },
  { id: "prevGroup", label: "Ir para o grupo anterior" },
];

export const DEFAULT_BINDINGS: Record<ShortcutAction, KeyBinding> = {
  autoGrid: { key: "g", ctrl: true, shift: false, alt: false, meta: false },
  nextGroup: { key: "Tab", ctrl: false, shift: false, alt: true, meta: false },
  prevGroup: { key: "Tab", ctrl: false, shift: true, alt: true, meta: false },
};

/** True if a keydown event matches a binding exactly (modifiers + key). */
export function matchBinding(e: KeyboardEvent, b: KeyBinding): boolean {
  if (e.ctrlKey !== b.ctrl || e.shiftKey !== b.shift || e.altKey !== b.alt || e.metaKey !== b.meta) {
    return false;
  }
  return e.key.toLowerCase() === b.key.toLowerCase();
}

/** Human-readable label, e.g. "Ctrl + Shift + Tab". */
export function formatBinding(b: KeyBinding): string {
  const parts: string[] = [];
  if (b.ctrl) parts.push("Ctrl");
  if (b.alt) parts.push("Alt");
  if (b.shift) parts.push("Shift");
  if (b.meta) parts.push("Meta");
  const key = b.key.length === 1 ? b.key.toUpperCase() : b.key;
  parts.push(key);
  return parts.join(" + ");
}

/** Modifier-only keys that can't be a shortcut's main key. */
export const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

interface ShortcutsState {
  bindings: Record<ShortcutAction, KeyBinding>;
  setBinding: (id: ShortcutAction, b: KeyBinding) => void;
  resetBinding: (id: ShortcutAction) => void;
  resetAll: () => void;
}

export const useShortcutsStore = create<ShortcutsState>()(
  persist(
    (set) => ({
      bindings: DEFAULT_BINDINGS,
      setBinding: (id, b) =>
        set((s) => ({ bindings: { ...s.bindings, [id]: b } })),
      resetBinding: (id) =>
        set((s) => ({ bindings: { ...s.bindings, [id]: DEFAULT_BINDINGS[id] } })),
      resetAll: () => set({ bindings: DEFAULT_BINDINGS }),
    }),
    {
      name: "turbo-shortcuts",
      storage: createJSONStorage(() => localStorage),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<ShortcutsState>;
        return {
          ...current,
          // Fill any missing action with its default so new actions don't break.
          bindings: { ...DEFAULT_BINDINGS, ...(p.bindings ?? {}) },
        };
      },
    }
  )
);
