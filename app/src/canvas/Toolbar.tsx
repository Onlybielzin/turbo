/**
 * Toolbar — Fixed overlay anchored top-left of the canvas viewport.
 *
 * "Novo grupo" creates the project (group) and SAVES an orchestrator agent into
 * it (chosen model + optional role prompt) — it does NOT open a terminal. All
 * agents live in the group's right side menu, where each is opened on demand.
 */
import { useCallback, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useCanvasStore, AGENT_OPTIONS, AGENT_COLORS } from "./store";
import "./Toolbar.css";

export function Toolbar() {
  const { addGroup, addAgentDef } = useCanvasStore();
  const [model, setModel] = useState("fable");
  const [prompt, setPrompt] = useState("");

  const handleNewGroup = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Escolher pasta do grupo",
    });
    if (!selected || typeof selected !== "string") return;

    const cwd = selected;
    const groupId = addGroup(cwd);

    // Save the orchestrator agent into the new project (no terminal yet).
    addAgentDef(groupId, {
      id: crypto.randomUUID(),
      name: "Orquestrador",
      model,
      prompt: prompt.trim(),
      color: AGENT_COLORS[0],
    });
  }, [addGroup, addAgentDef, model, prompt]);

  return (
    <div className="canvas-toolbar">
      <label className="canvas-toolbar__agent">
        <span className="canvas-toolbar__agent-label">Orquestrador</span>
        <select
          className="canvas-toolbar__select"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          aria-label="Modelo do agente orquestrador"
        >
          {AGENT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <input
        className="canvas-toolbar__prompt"
        type="text"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Papel do orquestrador (system prompt, opcional)"
        title="Papel/instruções do orquestrador — vira o system prompt"
      />
      <button
        type="button"
        className="canvas-toolbar__btn"
        onClick={handleNewGroup}
      >
        + Novo grupo
      </button>
    </div>
  );
}
