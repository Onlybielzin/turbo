import { Canvas } from "./canvas/Canvas";
import "./App.css";

function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="brand-mark">V</span>
        <span className="brand-name">Turbo</span>
        <span className="app-subtitle">canvas de agentes</span>
      </header>
      <Canvas />
    </div>
  );
}

export default App;
