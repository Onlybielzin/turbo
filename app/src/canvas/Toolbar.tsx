/**
 * Toolbar — Fixed overlay anchored top-left of the canvas viewport.
 *
 * Creates an EMPTY project (group) — agents are created only inside a group,
 * from its right side menu. Also shows which agent CLIs (Claude Code / Codex)
 * are available on this machine.
 */
import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useCanvasStore } from "./store";
import { checkForUpdates } from "../updater";
import "./Toolbar.css";

type CliStatus = { claude: boolean; codex: boolean };

export function Toolbar() {
  const addGroup = useCanvasStore((s) => s.addGroup);
  const [status, setStatus] = useState<CliStatus>({ claude: false, codex: false });
  const [checking, setChecking] = useState(false);

  const handleUpdate = useCallback(async () => {
    setChecking(true);
    try {
      await checkForUpdates(true);
    } finally {
      setChecking(false);
    }
  }, []);

  // Poll CLI availability so the top menu reflects what's usable.
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const s = await invoke<CliStatus>("cli_status");
        if (alive) setStatus(s);
      } catch {
        // ignore
      }
    };
    void check();
    const t = setInterval(() => void check(), 10000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const handleNewGroup = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Escolher pasta do grupo",
    });
    if (!selected || typeof selected !== "string") return;
    addGroup(selected);
  }, [addGroup]);

  return (
    <div className="canvas-toolbar">
      <div className="canvas-toolbar__status" title="CLIs de agente disponíveis nesta máquina">
        <span className={`canvas-toolbar__cli${status.claude ? " is-on" : ""}`}>
          <span className="canvas-toolbar__cli-dot" />
          Claude Code
        </span>
        <span className={`canvas-toolbar__cli${status.codex ? " is-on" : ""}`}>
          <span className="canvas-toolbar__cli-dot" />
          Codex
        </span>
      </div>
      <button
        type="button"
        className="canvas-toolbar__btn"
        onClick={handleNewGroup}
      >
        + Novo grupo
      </button>
      <button
        type="button"
        className="canvas-toolbar__btn"
        onClick={handleUpdate}
        disabled={checking}
        title="Verificar e instalar atualizações do Turbo"
      >
        {checking ? "Verificando…" : "↻ Atualizar"}
      </button>
    </div>
  );
}
