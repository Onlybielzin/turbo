import { useEffect } from "react";
import { Canvas } from "./canvas/Canvas";
import { ErrorBoundary } from "./canvas/ErrorBoundary";
import { checkForUpdates } from "./updater";
import "./App.css";

function App() {
  useEffect(() => {
    void checkForUpdates();
  }, []);

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="brand-mark">V</span>
        <span className="brand-name">Turbo</span>
        <span className="app-subtitle">canvas de agentes</span>
      </header>
      <ErrorBoundary label="Canvas">
        <Canvas />
      </ErrorBoundary>
    </div>
  );
}

export default App;
