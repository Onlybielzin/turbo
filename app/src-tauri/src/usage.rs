//! Token + cost accounting for agent terminals.
//!
//! Claude Code writes a transcript per session to
//! `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, one JSON object per
//! line. Assistant lines carry `message.model` and `message.usage`
//! (input/output/cache tokens). We pin a `--session-id` per terminal (see
//! `agent.rs`) so each terminal maps to exactly one transcript; the session id
//! is a unique UUID, so we locate the file by globbing all project dirs.
//!
//! Cost is derived from a per-model price table (USD per 1M tokens). There is no
//! cost field in the transcript, so these prices are an ESTIMATE — adjust
//! `price_for` if Anthropic pricing changes. Codex has no equivalent pinnable
//! transcript, so its terminals report zero here for now.

use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;

/// Aggregate usage for one session (terminal).
#[derive(Debug, Default, Clone, Serialize)]
pub struct UsageReport {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    /// input + output + cache (a single headline number for the UI).
    pub total_tokens: u64,
    pub cost_usd: f64,
    /// Whether a transcript was found (false → tokens unavailable, e.g. Codex).
    pub found: bool,
}

/// USD per 1,000,000 tokens for a model tier.
struct Price {
    input: f64,
    output: f64,
    cache_write: f64,
    cache_read: f64,
}

/// Price table (USD / 1M tokens). ESTIMATE — verify against current Anthropic
/// pricing. Matched by substring of the model id.
fn price_for(model: &str) -> Price {
    let m = model.to_ascii_lowercase();
    if m.contains("opus") {
        Price {
            input: 15.0,
            output: 75.0,
            cache_write: 18.75,
            cache_read: 1.5,
        }
    } else if m.contains("sonnet") {
        Price {
            input: 3.0,
            output: 15.0,
            cache_write: 3.75,
            cache_read: 0.3,
        }
    } else if m.contains("haiku") {
        Price {
            input: 1.0,
            output: 5.0,
            cache_write: 1.25,
            cache_read: 0.1,
        }
    } else if m.contains("fable") {
        // TODO: verify Fable 5 pricing — placeholder mirrors the Sonnet tier.
        Price {
            input: 3.0,
            output: 15.0,
            cache_write: 3.75,
            cache_read: 0.3,
        }
    } else {
        Price {
            input: 0.0,
            output: 0.0,
            cache_write: 0.0,
            cache_read: 0.0,
        }
    }
}

/// Locate `<session_id>.jsonl` under any `~/.claude/projects/*/` directory.
fn find_transcript(session_id: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let projects = PathBuf::from(home).join(".claude").join("projects");
    let target = format!("{session_id}.jsonl");
    for entry in fs::read_dir(&projects).ok()?.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let candidate = entry.path().join(&target);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Sum token usage + cost across all assistant messages of a session.
pub fn session_usage(session_id: &str) -> UsageReport {
    let mut report = UsageReport::default();
    let Some(path) = find_transcript(session_id) else {
        return report;
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return report;
    };
    report.found = true;

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let msg = &v["message"];
        let usage = &msg["usage"];
        if usage.is_null() {
            continue;
        }
        let model = msg["model"].as_str().unwrap_or("");
        let get = |k: &str| usage[k].as_u64().unwrap_or(0);
        let input = get("input_tokens");
        let output = get("output_tokens");
        let cache_w = get("cache_creation_input_tokens");
        let cache_r = get("cache_read_input_tokens");

        report.input_tokens += input;
        report.output_tokens += output;
        report.cache_creation_input_tokens += cache_w;
        report.cache_read_input_tokens += cache_r;

        let p = price_for(model);
        report.cost_usd += (input as f64 * p.input
            + output as f64 * p.output
            + cache_w as f64 * p.cache_write
            + cache_r as f64 * p.cache_read)
            / 1_000_000.0;
    }

    report.total_tokens = report.input_tokens
        + report.output_tokens
        + report.cache_creation_input_tokens
        + report.cache_read_input_tokens;
    report
}
