#!/usr/bin/env bash
# Zero-cost stand-in for `claude -p` used by the spike's --fake mode.
# Sleeps FAKE_SLEEP seconds (default 1) then echoes the task back.
SLEEP="${FAKE_SLEEP:-1}"
echo "[fake-agent] start (depth=${TURBO_MCP_DEPTH:-0}) task: $*"
sleep "$SLEEP"
echo "[fake-agent] done: $*"
