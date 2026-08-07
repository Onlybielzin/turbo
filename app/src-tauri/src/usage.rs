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

use std::collections::HashSet;
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
        // Opus 4.x / 5 official rates (per 1M): $5 in, $25 out.
        // cache write 5m = 1.25x input, cache read = 0.1x input.
        Price {
            input: 5.0,
            output: 25.0,
            cache_write: 6.25,
            cache_read: 0.5,
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
    let Some(home) = crate::platform::home_dir() else {
        return out;
    };
    let projects = home.join(".claude").join("projects");
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

    // Dedupe by (message.id, requestId): Claude Code frequently writes the SAME
    // assistant response to the transcript more than once (streaming + final, or
    // duplicated lines). Summing every line double-counts a turn — e.g. a single
    // "oi" showing ~76k instead of ~38k. Count each unique API response once.
    let mut seen: HashSet<String> = HashSet::new();

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
            if let Some(id) = msg["id"].as_str() {
                let req = v["requestId"].as_str().unwrap_or("");
                if !seen.insert(format!("{id}|{req}")) {
                    continue;
                }
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

// ── Codex usage ────────────────────────────────────────────────────────────────
// Codex (OpenAI CLI) logs to ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. The
// first line (type "session_meta") carries `payload.cwd`; per-turn usage lives in
// `payload.info.last_token_usage` of "token_count" events. We locate the newest
// rollout whose session cwd matches the terminal's cwd and sum its per-turn deltas
// (deduping identical events), mirroring ccusage's codex adapter.

/// GPT-5 / Codex price estimate (USD per 1M tokens). Codex has no cost field in
/// its logs, so this is an ESTIMATE using published GPT-5 API rates.
const CODEX_INPUT_PRICE: f64 = 1.25;
const CODEX_CACHED_INPUT_PRICE: f64 = 0.125;
const CODEX_OUTPUT_PRICE: f64 = 10.0;

/// Recursively collect `rollout-*.jsonl` files under `dir`.
fn collect_rollouts(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            collect_rollouts(&path, out);
        } else if path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with("rollout-") && n.ends_with(".jsonl"))
            .unwrap_or(false)
        {
            out.push(path);
        }
    }
}

/// Newest Codex rollout file whose session_meta cwd matches `cwd`.
fn find_codex_rollout(cwd: &str) -> Option<PathBuf> {
    let home = crate::platform::home_dir()?;
    let sessions = home.join(".codex").join("sessions");
    let mut rollouts = Vec::new();
    collect_rollouts(&sessions, &mut rollouts);

    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for path in rollouts {
        // The cwd is on the first line (session_meta). Read just that line.
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Some(first) = text.lines().next() else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(first) else {
            continue;
        };
        let meta_cwd = v["cwd"].as_str().or_else(|| v["payload"]["cwd"].as_str());
        if meta_cwd != Some(cwd) {
            continue;
        }
        let mtime = path
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        if best.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
            best = Some((mtime, path));
        }
    }
    best.map(|(_, p)| p)
}

/// Aggregate Codex token usage for the newest session in `cwd`.
pub fn codex_usage(cwd: &str) -> UsageReport {
    let mut report = UsageReport::default();
    let Some(path) = find_codex_rollout(cwd) else {
        return report;
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return report;
    };
    report.found = true;

    // Dedupe identical token_count events (same per-turn counts back-to-back).
    let mut seen: HashSet<String> = HashSet::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v["payload"]["type"].as_str() != Some("token_count") {
            continue;
        }
        let last = &v["payload"]["info"]["last_token_usage"];
        if last.is_null() {
            continue;
        }
        let get = |k: &str| last[k].as_u64().unwrap_or(0);
        let input = get("input_tokens"); // full input (includes cached)
        let cached = get("cached_input_tokens");
        let cache_w = get("cache_write_input_tokens");
        let output = get("output_tokens") + get("reasoning_output_tokens");

        // Dedupe key: the raw counters of this turn.
        if !seen.insert(format!("{input}|{cached}|{cache_w}|{output}")) {
            continue;
        }

        let uncached = input.saturating_sub(cached);
        report.input_tokens += uncached;
        report.cache_read_input_tokens += cached;
        report.cache_creation_input_tokens += cache_w;
        report.output_tokens += output;

        report.cost_usd += (uncached as f64 * CODEX_INPUT_PRICE
            + cached as f64 * CODEX_CACHED_INPUT_PRICE
            + output as f64 * CODEX_OUTPUT_PRICE)
            / 1_000_000.0;
    }

    // Same headline convention as Claude: exclude cache_read.
    report.total_tokens =
        report.input_tokens + report.output_tokens + report.cache_creation_input_tokens;
    report
}
