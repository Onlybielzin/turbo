/**
 * SettingsModal — user preferences for the canvas.
 *
 * Currently exposes the LOD threshold: the zoom level below which terminals
 * collapse to a lightweight placeholder (the big lever for panoramic-view lag).
 * The value persists via the settings store; changes apply live.
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  useSettingsStore,
  LOD_ZOOM_MIN,
  LOD_ZOOM_MAX,
  LOD_ZOOM_DEFAULT,
} from "./settings";
import {
  useShortcutsStore,
  SHORTCUT_ACTIONS,
  formatBinding,
  MODIFIER_KEYS,
  ShortcutAction,
  KeyBinding,
} from "./shortcuts";
import "./SettingsModal.css";

interface SettingsModalProps {
  onClose: () => void;
}

export function SettingsModal({ onClose }: SettingsModalProps) {
  const lodZoom = useSettingsStore((s) => s.lodZoom);
  const setLodZoom = useSettingsStore((s) => s.setLodZoom);

  const bindings = useShortcutsStore((s) => s.bindings);
  const setBinding = useShortcutsStore((s) => s.setBinding);
  const resetBinding = useShortcutsStore((s) => s.resetBinding);
  // Which shortcut (if any) is currently waiting for a key combo.
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null);

  // Capture mode: the next non-modifier keydown becomes the new binding.
  // Runs in capture phase + stops propagation so the combo never reaches the
  // app's own shortcut handlers while rebinding. Escape cancels.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      if (MODIFIER_KEYS.has(e.key)) return; // wait for a real key
      const b: KeyBinding = {
        key: e.key,
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey,
        meta: e.metaKey,
      };
      setBinding(capturing, b);
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, setBinding]);

  // Close on Escape (but not while capturing — that Escape cancels capture).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !capturing) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, capturing]);

  const pct = Math.round(lodZoom * 100);
  const handleSlider = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setLodZoom(Number(e.target.value) / 100);
    },
    [setLodZoom]
  );

  return createPortal(
    <div className="settings-overlay" onClick={onClose}>
      <div
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Configurações"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-modal__header">
          <h2 className="settings-modal__title">Configurações</h2>
          <button
            type="button"
            className="settings-modal__close"
            onClick={onClose}
            aria-label="Fechar"
          >
            ×
          </button>
        </div>

        <div className="settings-modal__body">
          <section className="settings-field">
            <div className="settings-field__head">
              <label htmlFor="lod-zoom" className="settings-field__label">
                Simplificar terminais ao afastar
              </label>
              <span className="settings-field__value">{pct}%</span>
            </div>
            <p className="settings-field__hint">
              Abaixo deste nível de zoom, os terminais viram um cartão leve (só o
              nome) para o canvas ficar fluido na visão panorâmica. Valores maiores
              simplificam mais cedo; menores mantêm o texto por mais tempo.
            </p>
            <input
              id="lod-zoom"
              type="range"
              className="settings-field__slider"
              min={Math.round(LOD_ZOOM_MIN * 100)}
              max={Math.round(LOD_ZOOM_MAX * 100)}
              step={5}
              value={pct}
              onChange={handleSlider}
            />
            <div className="settings-field__scale">
              <span>{Math.round(LOD_ZOOM_MIN * 100)}%</span>
              <button
                type="button"
                className="settings-field__reset"
                onClick={() => setLodZoom(LOD_ZOOM_DEFAULT)}
              >
                Padrão ({Math.round(LOD_ZOOM_DEFAULT * 100)}%)
              </button>
              <span>{Math.round(LOD_ZOOM_MAX * 100)}%</span>
            </div>
          </section>

          <section className="settings-field">
            <div className="settings-field__head">
              <span className="settings-field__label">Atalhos de teclado</span>
            </div>
            <p className="settings-field__hint">
              Clique em um atalho e pressione a nova combinação. Esc cancela.
            </p>
            <ul className="settings-shortcuts">
              {SHORTCUT_ACTIONS.map((action) => (
                <li key={action.id} className="settings-shortcut">
                  <span className="settings-shortcut__label">{action.label}</span>
                  <span className="settings-shortcut__controls">
                    <button
                      type="button"
                      className={`settings-shortcut__combo${
                        capturing === action.id ? " is-capturing" : ""
                      }`}
                      onClick={() => setCapturing(action.id)}
                    >
                      {capturing === action.id
                        ? "Pressione…"
                        : formatBinding(bindings[action.id])}
                    </button>
                    <button
                      type="button"
                      className="settings-shortcut__reset"
                      onClick={() => resetBinding(action.id)}
                      title="Restaurar padrão"
                      aria-label="Restaurar padrão"
                    >
                      ↺
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>,
    document.body
  );
}
