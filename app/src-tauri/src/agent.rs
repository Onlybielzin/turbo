//! Agent backend abstraction.
//!
//! Turbo can run each agent on a different CLI/model, chosen per-agent so a
//! single canvas can mix e.g. a Fable orchestrator, Opus backend workers, and a
//! Codex security agent. This module is the single source of truth for turning
//! an agent token into the concrete command + args for both the interactive
//! parent terminal and the non-interactive child spawned by `spawn_agent`.
//!
//! An agent's ROLE is a system prompt, NOT the first user message — passing it
//! positionally would make the agent immediately act on it. So the role is
//! injected as `--append-system-prompt` (Claude) or `-c developer_instructions`
//! (Codex). Only a `spawn_agent` child's one-shot TASK is a positional prompt.

/// Which CLI/model runs an agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentBackend {
    /// Claude Code CLI, optionally pinned to a model alias (fable|opus|sonnet|haiku).
    Claude { model: Option<String> },
    /// OpenAI Codex CLI, optionally pinned to a GPT model slug (e.g. gpt-5.6-sol).
    Codex { model: Option<String> },
}

/// Trim a role/prompt and return it only if non-empty.
fn clean_role(role: Option<&str>) -> Option<&str> {
    role.map(|s| s.trim()).filter(|s| !s.is_empty())
}

impl AgentBackend {
    /// Parse a short agent token into a backend.
    /// - `"codex"` → Codex with the CLI's default model
    /// - `"codex:<slug>"` → Codex pinned to that GPT model (e.g. `codex:gpt-5.6-sol`)
    /// - `""` / `"claude"` → Claude with the CLI's default model
    /// - anything else (`"fable"`, `"opus"`, `"sonnet"`, `"haiku"`, …) → Claude pinned to that model
    pub fn parse(token: &str) -> Self {
        let lower = token.trim().to_ascii_lowercase();
        if lower == "codex" {
            return AgentBackend::Codex { model: None };
        }
        if let Some(slug) = lower.strip_prefix("codex:") {
            let slug = slug.trim();
            return AgentBackend::Codex {
                model: (!slug.is_empty()).then(|| slug.to_string()),
            };
        }
        match lower.as_str() {
            "" | "claude" => AgentBackend::Claude { model: None },
            other => AgentBackend::Claude {
                model: Some(other.to_string()),
            },
        }
    }

    /// The binary name.
    pub fn program(&self) -> &'static str {
        match self {
            AgentBackend::Claude { .. } => "claude",
            AgentBackend::Codex { .. } => "codex",
        }
    }

    /// Whether this backend discovers the MCP server via a `.mcp.json` file in
    /// the cwd (Claude) versus an inline `-c` flag (Codex).
    pub fn uses_mcp_json(&self) -> bool {
        matches!(self, AgentBackend::Claude { .. })
    }

    /// Args that inject the agent's ROLE as a system prompt (empty if no role).
    /// Passed as a single argv element each — no shell/TOML escaping needed:
    /// Claude reads `--append-system-prompt <text>` verbatim; Codex's `-c`
    /// falls back to a raw string literal when the value isn't valid TOML, so
    /// `developer_instructions=<text>` carries arbitrary text (spaces, quotes,
    /// newlines) safely.
    fn role_args(&self, role: Option<&str>) -> Vec<String> {
        match (self, clean_role(role)) {
            (_, None) => Vec::new(),
            (AgentBackend::Claude { .. }, Some(r)) => {
                vec!["--append-system-prompt".to_string(), r.to_string()]
            }
            (AgentBackend::Codex { .. }, Some(r)) => {
                vec!["-c".to_string(), format!("developer_instructions={r}")]
            }
        }
    }

    /// Command + args for the INTERACTIVE parent terminal.
    ///
    /// `mcp_url` wires the embedded MCP server (Claude via the `.mcp.json` file,
    /// Codex via inline `-c`). `role` becomes the agent's system prompt.
    /// `session_id` (Claude only) pins the transcript file so token/cost usage
    /// can be read back per terminal; Codex ignores it.
    ///
    /// `resume` picks first-launch vs continue-the-conversation. The port in
    /// `mcp_url` is THIS session's (composed fresh at spawn time), so a restored
    /// terminal never dials a dead port:
    /// - Claude: `--session-id <id>` (create-only) on first launch, `--resume
    ///   <id>` to continue.
    /// - Codex: bare interactive TUI on first launch, `… resume --last` (most
    ///   recent session in this cwd) to continue. Flags stay top-level, before
    ///   the `resume` subcommand.
    pub fn parent_command(
        &self,
        mcp_url: &str,
        role: Option<&str>,
        session_id: Option<&str>,
        resume: bool,
    ) -> (String, Vec<String>) {
        match self {
            AgentBackend::Claude { model } => {
                // Bypass permission prompts so the chat is usable unattended.
                let mut a = vec!["--dangerously-skip-permissions".to_string()];
                if let Some(m) = model {
                    a.push("--model".to_string());
                    a.push(m.clone());
                }
                if let Some(sid) = session_id.filter(|s| !s.is_empty()) {
                    // --session-id is create-only; --resume continues an existing
                    // session (re-running --session-id would error "already in use").
                    a.push(if resume { "--resume" } else { "--session-id" }.to_string());
                    a.push(sid.to_string());
                }
                a.extend(self.role_args(role));
                (self.program().to_string(), a)
            }
            AgentBackend::Codex { model } => {
                let mut a = vec!["--dangerously-bypass-approvals-and-sandbox".to_string()];
                if let Some(m) = model {
                    a.push("-m".to_string());
                    a.push(m.clone());
                }
                a.push("-c".to_string());
                a.push(format!("mcp_servers.turbo.url=\"{mcp_url}\""));
                a.extend(self.role_args(role));
                if resume {
                    a.push("resume".to_string());
                    a.push("--last".to_string());
                }
                (self.program().to_string(), a)
            }
        }
    }

    /// Command + args for a NON-INTERACTIVE child agent running `task`.
    /// `task` is the one-shot user message (positional); `role` is the system prompt.
    pub fn child_command(&self, task: &str, role: Option<&str>) -> (String, Vec<String>) {
        match self {
            AgentBackend::Claude { model } => {
                let mut args = vec!["-p".to_string(), task.to_string()];
                if let Some(m) = model {
                    args.push("--model".to_string());
                    args.push(m.clone());
                }
                args.extend(self.role_args(role));
                args.push("--output-format".to_string());
                args.push("text".to_string());
                args.push("--dangerously-skip-permissions".to_string());
                (self.program().to_string(), args)
            }
            AgentBackend::Codex { model } => {
                let mut args = vec![
                    "exec".to_string(),
                    "--dangerously-bypass-approvals-and-sandbox".to_string(),
                    "--skip-git-repo-check".to_string(),
                ];
                if let Some(m) = model {
                    args.push("-m".to_string());
                    args.push(m.clone());
                }
                args.extend(self.role_args(role));
                args.push(task.to_string());
                (self.program().to_string(), args)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_codex_and_claude_models() {
        assert_eq!(AgentBackend::parse("codex"), AgentBackend::Codex { model: None });
        assert_eq!(
            AgentBackend::parse("codex:gpt-5.6-sol"),
            AgentBackend::Codex {
                model: Some("gpt-5.6-sol".to_string())
            }
        );
        assert_eq!(
            AgentBackend::parse(""),
            AgentBackend::Claude { model: None }
        );
        assert_eq!(
            AgentBackend::parse("Fable"),
            AgentBackend::Claude {
                model: Some("fable".to_string())
            }
        );
    }

    #[test]
    fn codex_child_is_non_interactive_with_bypass() {
        let (cmd, args) = (AgentBackend::Codex { model: None }).child_command("do it", None);
        assert_eq!(cmd, "codex");
        assert_eq!(args[0], "exec");
        assert!(args.contains(&"--dangerously-bypass-approvals-and-sandbox".to_string()));
        assert_eq!(args.last().unwrap(), "do it");
    }

    #[test]
    fn codex_parent_wires_mcp_inline() {
        let (_cmd, args) =
            (AgentBackend::Codex { model: None }).parent_command("http://127.0.0.1:9/mcp?group_id=g", None, None, false);
        assert!(args.contains(&"--dangerously-bypass-approvals-and-sandbox".to_string()));
        assert!(args.iter().any(|a| a == "-c"));
        assert!(args
            .iter()
            .any(|a| a.contains("mcp_servers.turbo.url=") && a.contains("group_id=g")));
        // Fresh launch: no resume subcommand.
        assert!(!args.contains(&"resume".to_string()));
    }

    #[test]
    fn codex_model_flows_to_both_commands() {
        let b = AgentBackend::parse("codex:gpt-5.6-terra");
        let (_c, pargs) = b.parent_command("http://x/mcp", None, None, false);
        let i = pargs.iter().position(|s| s == "-m").unwrap();
        assert_eq!(pargs[i + 1], "gpt-5.6-terra");
        let (_c2, cargs) = b.child_command("t", None);
        assert!(cargs.windows(2).any(|w| w[0] == "-m" && w[1] == "gpt-5.6-terra"));
    }

    #[test]
    fn resume_composes_continue_flags() {
        // Codex: `… resume --last` appended (flags stay before the subcommand).
        let (_c, cargs) =
            (AgentBackend::Codex { model: None }).parent_command("http://x/mcp", None, None, true);
        let ri = cargs.iter().position(|s| s == "resume").unwrap();
        assert_eq!(cargs[ri + 1], "--last");
        assert!(cargs.iter().position(|s| s == "-c").unwrap() < ri); // -c before resume

        // Claude: --resume <id> to continue; --session-id only on fresh launch.
        let claude = AgentBackend::parse("opus");
        let (_c2, fresh) = claude.parent_command("u", None, Some("sid-1"), false);
        assert!(fresh.contains(&"--session-id".to_string()) && !fresh.contains(&"--resume".to_string()));
        let (_c3, cont) = claude.parent_command("u", None, Some("sid-1"), true);
        assert!(cont.contains(&"--resume".to_string()) && !cont.contains(&"--session-id".to_string()));
        let i = cont.iter().position(|s| s == "--resume").unwrap();
        assert_eq!(cont[i + 1], "sid-1");
    }

    #[test]
    fn claude_model_flows_to_both_commands() {
        let b = AgentBackend::parse("opus");
        let (_c, pargs) = b.parent_command("unused", None, None, false);
        assert!(pargs.contains(&"--model".to_string()) && pargs.contains(&"opus".to_string()));
        assert!(pargs.contains(&"--dangerously-skip-permissions".to_string()));
        let (_c2, cargs) = b.child_command("t", None);
        assert!(cargs.contains(&"--model".to_string()) && cargs.contains(&"opus".to_string()));
    }

    #[test]
    fn role_becomes_system_prompt_not_positional() {
        // Claude: --append-system-prompt <role>, task stays the -p positional.
        let (_c, a) = AgentBackend::parse("fable").child_command("faça X", Some("Você é backend"));
        let i = a
            .iter()
            .position(|s| s == "--append-system-prompt")
            .unwrap();
        assert_eq!(a[i + 1], "Você é backend");
        assert_eq!(a[1], "faça X"); // -p positional is the task, not the role

        // Codex interactive: -c developer_instructions=<role>, no positional prompt.
        let (_c2, a2) =
            (AgentBackend::Codex { model: None }).parent_command("http://x/mcp", Some("Você é seguranca"), None, false);
        assert!(a2
            .iter()
            .any(|s| s == "developer_instructions=Você é seguranca"));
    }

    #[test]
    fn empty_role_adds_no_flags() {
        let (_c, a) = AgentBackend::parse("fable").parent_command("x", Some("   "), None, false);
        assert!(!a.contains(&"--append-system-prompt".to_string()));
    }
}
