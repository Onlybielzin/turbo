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
use std::path::{Path, PathBuf};

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

/// Collect every `*.jsonl` file under `dir` (recursively) into `out`.
fn collect_jsonl(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            collect_jsonl(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

/// Locate all transcript files for a session under `~/.claude/projects/*/`.
///
/// Claude Code 2.1.x stores a session as BOTH a flat `<session_id>.jsonl` (the
/// parent transcript, written when a turn completes) AND a `<session_id>/`
/// directory holding nested transcripts (`subagents/*.jsonl`, etc.). We read
/// both so token/cost accounting includes subagent usage and works with the
/// newer directory layout — not just the flat file.
fn find_transcripts(session_id: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Some(home) = std::env::var_os("HOME") else {
        return out;
    };
    let projects = PathBuf::from(home).join(".claude").join("projects");
    let flat = format!("{session_id}.jsonl");
    let Ok(rd) = fs::read_dir(&projects) else {
        return out;
    };
    for entry in rd.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let proj = entry.path();
        let flat_path = proj.join(&flat);
        if flat_path.is_file() {
            out.push(flat_path);
        }
        let session_dir = proj.join(session_id);
        if session_dir.is_dir() {
            collect_jsonl(&session_dir, &mut out);
        }
    }
    out
}

/// Sum token usage + cost across all assistant messages of a session.
pub fn session_usage(session_id: &str) -> UsageReport {
    let mut report = UsageReport::default();
    let paths = find_transcripts(session_id);
    if paths.is_empty() {
        return report;
    }
    report.found = true;

    for path in paths {
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
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
    }

    // Headline token count = "new work": fresh input + output + cache writes.
    // cache_read is the (cheap, 0.1x-priced) re-read of already-cached context —
    // it dominates the raw total (often >90%) and balloons every turn, which made
    // a single "oi" read as tens of thousands of tokens. Exclude it from the
    // headline; it still lives in cache_read_input_tokens and is priced into cost.
    report.total_tokens = report.input_tokens
        + report.output_tokens
        + report.cache_creation_input_tokens;
    report
}
