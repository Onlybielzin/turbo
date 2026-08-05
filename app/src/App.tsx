import { Terminal } from "./components/Terminal";
import "./App.css";

function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="brand-mark">V</span>
        <span className="brand-name">Turbo</span>
        <span className="app-subtitle">canvas de agentes — phase 1</span>
      </header>
      <main className="term-wrap">
        <Terminal />
      </main>
    </div>
  );
}

export default App;
