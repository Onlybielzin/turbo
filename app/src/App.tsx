import { useCallback, useEffect, useState } from "react";
import { Canvas } from "./canvas/Canvas";
import { ErrorBoundary } from "./canvas/ErrorBoundary";
import { checkForUpdates } from "./updater";
import "./App.css";

function App() {
  const [checking, setChecking] = useState(false);

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
        <Canvas />
      </ErrorBoundary>
    </div>
  );
}

export default App;
