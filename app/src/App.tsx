import { useCallback, useEffect, useState } from "react";
import { Canvas } from "./canvas/Canvas";
import { ErrorBoundary } from "./canvas/ErrorBoundary";
import { checkForUpdates } from "./updater";
import { prepareRestore } from "./canvas/mcp";
import "./App.css";

function App() {
  const [checking, setChecking] = useState(false);
  // Gate the canvas on restore-prep: recompose every restored agent terminal's
  // launch command for THIS session's MCP port + resume flags BEFORE they mount
  // and spawn (avoids dead-port MCP handshakes and fresh-instead-of-resumed chats).
  const [mcpReady, setMcpReady] = useState(false);

  useEffect(() => {
    void prepareRestore().finally(() => setMcpReady(true));
  }, []);

  useEffect(() => {
    void checkForUpdates();
  }, []);

  const handleUpdate = useCallback(async () => {
    setChecking(true);
    try {
      await checkForUpdates(true);
    } finally {
      setChecking(false);
    }
  }, []);

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="brand-mark">V</span>
        <span className="brand-name">Turbo</span>
        <span className="app-subtitle">canvas de agentes</span>
        <button
          type="button"
          className="app-header__update"
          onClick={handleUpdate}
          disabled={checking}
          title="Verificar e instalar atualizações do Turbo"
        >
          {checking ? "Verificando…" : "↻ Atualizar"}
        </button>
      </header>
      <ErrorBoundary label="Canvas">
        {mcpReady ? <Canvas /> : null}
      </ErrorBoundary>
    </div>
  );
}

export default App;
