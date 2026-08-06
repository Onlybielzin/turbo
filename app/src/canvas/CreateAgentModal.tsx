/**
 * CreateAgentModal — modal to SAVE an agent into a project (group).
 *
 * Creating an agent only stores its definition (name, model, prompt/role,
 * color) — it does NOT open a terminal. The agent then appears in the group's
 * right side menu, where an "Abrir terminal" button launches its terminal on
 * demand. Offers ready-made presets plus a custom form and a color picker.
 */
import { useState, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  AGENT_OPTIONS,
  AGENT_PRESETS,
  AGENT_COLORS,
  AgentPreset,
  useCanvasStore,
} from "./store";
import "./CreateAgentModal.css";

interface CreateAgentModalProps {
  groupId: string;
  defaultColor: string;
  onClose: () => void;
}

export function CreateAgentModal({ groupId, defaultColor, onClose }: CreateAgentModalProps) {
  const addAgentDef = useCanvasStore((s) => s.addAgentDef);
  const [name, setName] = useState("");
  const [model, setModel] = useState("fable");
  const [prompt, setPrompt] = useState("");
  const [color, setColor] = useState(defaultColor);

  const applyPreset = useCallback((p: AgentPreset) => {
    setName(p.name);
    setModel(p.model);
    setPrompt(p.prompt);
  }, []);

  const handleCreate = useCallback(() => {
    const trimmedName = name.trim() || `Agente ${model}`;
    addAgentDef(groupId, {
      id: crypto.randomUUID(),
      name: trimmedName,
      model,
      prompt: prompt.trim(),
      color,
    });
    onClose();
  }, [groupId, name, model, prompt, color, addAgentDef, onClose]);

  return createPortal(
    <div className="agent-modal__backdrop" onClick={onClose}>
      <div
        className="agent-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Criar agente"
      >
        <div className="agent-modal__header">
          <h2 className="agent-modal__title">Criar agente</h2>
          <button
            type="button"
            className="agent-modal__close"
            onClick={onClose}
            aria-label="Fechar"
          >
            ✕
          </button>
        </div>

        <div className="agent-modal__section-label">Presets</div>
        <div className="agent-modal__presets">
          {AGENT_PRESETS.map((p) => (
            <button
              key={p.name}
              type="button"
              className={`agent-modal__preset${
                name === p.name && model === p.model ? " is-active" : ""
              }`}
              onClick={() => applyPreset(p)}
            >
              <span className="agent-modal__preset-name">{p.name}</span>
              <span className="agent-modal__preset-model">{p.model}</span>
            </button>
          ))}
        </div>

        <div className="agent-modal__form">
          <label className="agent-modal__field">
            <span>Nome</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ex.: Backend"
            />
          </label>

          <label className="agent-modal__field">
            <span>Modelo</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {AGENT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <div className="agent-modal__field agent-modal__field--full">
            <span>Cor</span>
            <div className="agent-modal__swatches">
              {AGENT_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`agent-modal__swatch${color === c ? " is-active" : ""}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  aria-label={`Cor ${c}`}
                />
              ))}
            </div>
          </div>

          <label className="agent-modal__field agent-modal__field--full">
            <span>Prompt / papel (system prompt)</span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="Papel do agente — vira o system prompt, não a primeira mensagem (opcional)"
            />
          </label>
        </div>

        <div className="agent-modal__actions">
          <button type="button" className="agent-modal__btn" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="agent-modal__btn agent-modal__btn--primary"
            onClick={handleCreate}
          >
            Salvar agente
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
