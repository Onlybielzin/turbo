import ReactDOM from "react-dom/client";
import App from "./App";

// StrictMode intentionally disabled: each TerminalNode mount spawns a REAL
// `claude` child process via a PTY. StrictMode's dev-only double-invoke of
// effects (setup → cleanup → setup) would spawn and immediately kill a second
// claude per node — wasteful churn for a tool whose purpose is spawning agents.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
