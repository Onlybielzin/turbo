/**
 * CreateAgentModal — modal to add an agent to a project (group).
 *
 * Offers ready-made presets (role + model + prompt) plus a custom form (name,
 * model, prompt). On create it wires MCP for the chosen backend via the
 * `create_group` Tauri command (writes `.mcp.json` for Claude, returns the
 * inline URL for Codex), then spawns the agent terminal in the group with the
 * prompt as the interactive CLI's positional [PROMPT].
 */
import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AGENT_OPTIONS,
  AGENT_PRESETS,
  AgentPreset,
  useCanvasStore,
} from "./store";
import "./CreateAgentModal.css";

type ParentSpawn = { command: string; args: string[] };

interface CreateAgentModalProps {
  groupId: string;
  cwd: string;
  onClose: () => void;
}

export function CreateAgentModal({ groupId, cwd, onClose }: CreateAgentModalProps) {
  const { addTerminalNode, updateNodeLabel } = useCanvasStore();
  const [name, setName] = useState("");
  const [model, setModel] = useState("fable");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  const applyPreset = useCallback((p: AgentPreset) => {
    setName(p.name);
    setModel(p.model);
    setPrompt(p.prompt);
  }, []);

  const handleCreate = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Wire MCP for THIS agent's backend and get its launch command+args.
      const spawn = await invoke<ParentSpawn>("create_group", {
        groupId,
        cwd,
        backend: model,
      });
      const args = prompt.trim() ? [...spawn.args, prompt.trim()] : spawn.args;
      const nodeId = addTerminalNode(
        groupId,
        null,
        cwd,
        spawn.command,
        [
          ["TURBO_GROUP_ID", groupId],
          ["TURBO_MCP_DEPTH", "0"],
          ["TURBO_AGENT", model],
        ],
        args,
      );
      if (name.trim()) updateNodeLabel(nodeId, name.trim());
      onClose();
    } catch (err) {
      console.error("[Turbo] create agent failed:", err);
      setBusy(false);
    }
  }, [busy, groupId, cwd, model, prompt, name, addTerminalNode, updateNodeLabel, onClose]);

  return (
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

          <label className="agent-modal__field agent-modal__field--full">
            <span>Prompt</span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="Papel / instruções iniciais do agente (opcional)"
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
            disabled={busy}
          >
            {busy ? "Criando…" : "Criar agente"}
          </button>
        </div>
      </div>
    </div>
  );
}
