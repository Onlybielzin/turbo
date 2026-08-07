/**
 * Restore preparation — compose-at-spawn for restored agent terminals.
 *
 * The embedded MCP server binds an EPHEMERAL port that changes every launch, and
 * agent CLIs need to CONTINUE the previous conversation on reopen (Claude via
 * `--resume`, Codex via `resume --last`). Replaying the persisted launch args is
 * fragile: the baked MCP port goes stale, and older nodes may have no args at all.
 *
 * Instead we RE-COMPOSE each restored terminal's command from its stable identity
 * (backend + role + sessionId + cwd) via the Rust `create_group` command with
 * `resume: true`. That registers the group on THIS session's port (rewriting
 * `.mcp.json` for Claude) and returns a launch command wired to the current port
 * with the correct resume flags. We run this BEFORE the canvas mounts (App gates
 * on it) so terminals never spawn stale.
 */
import { invoke } from "@tauri-apps/api/core";
import { useCanvasStore, type TerminalNodeData } from "./store";

type ParentSpawn = { command: string; args: string[] };

function envGet(
  env: [string, string][] | undefined,
  key: string
): string | undefined {
  return env?.find(([k]) => k === key)?.[1];
}

/** Recompose every restored agent terminal so it resumes on this session's MCP
 *  port. Plain shells and terminals missing identity are left untouched. */
export async function prepareRestore(): Promise<void> {
  const { nodes, setTerminalSpawn } = useCanvasStore.getState();
  const terminals = nodes.filter((n) => n.type === "terminal");

  await Promise.all(
    terminals.map(async (n) => {
      const d = n.data as TerminalNodeData;
      if (!d.command) return; // plain shell — nothing to compose

      const backend = d.agent ?? envGet(d.env, "TURBO_AGENT") ?? d.command;
      const groupId = n.parentId ?? envGet(d.env, "TURBO_GROUP_ID");
      const cwd = d.worktree ?? d.cwd;
      if (!groupId || !cwd) return;

      try {
        const spawn = await invoke<ParentSpawn>("create_group", {
          groupId,
          cwd,
          backend,
          prompt: d.role ?? null,
          sessionId: d.sessionId ?? null,
          resume: true,
        });
        setTerminalSpawn(n.id, spawn.command, spawn.args);
      } catch {
        // Compose/register failed — keep persisted args; usePty still tries them.
      }
    })
  );
}
