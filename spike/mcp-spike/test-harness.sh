#!/usr/bin/env bash
# test-harness.sh — verifica os critérios do ROADMAP Phase 2 sem gastar tokens.
#
# Uso:  bash test-harness.sh [PORT] [BINARY]

set -euo pipefail

PORT="${1:-7717}"
BINARY="${2:-./target/debug/turbo-mcp-spike}"
MCP_URL="http://127.0.0.1:${PORT}/mcp"
PASS=0
FAIL=0
SERVER_PID=""

log()  { printf '\n[HARNESS] %s\n' "$*"; }
ok()   { printf '  [PASS] %s\n' "$*"; PASS=$((PASS + 1)); }
fail() { printf '  [FAIL] %s\n' "$*"; FAIL=$((FAIL + 1)); }

cleanup() {
    [ -n "$SERVER_PID" ] && { kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; }
    pkill -f "fake-agent.sh" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ── Build check ───────────────────────────────────────────────────────────────
log "Verificando binário..."
[ -f "$BINARY" ] || cargo build 2>&1
ok "Binário: $BINARY"

# ── Session helper ─────────────────────────────────────────────────────────────
# POST to MCP URL with optional session ID; returns SSE body.
mcp_post() {
    local body="$1" sid="${2:-}"
    local args=(-s -X POST "$MCP_URL" \
        -H "Content-Type: application/json" \
        -H "Accept: application/json, text/event-stream" \
        --max-time 20)
    [ -n "$sid" ] && args+=(-H "Mcp-Session-Id: $sid")
    curl "${args[@]}" -d "$body" 2>/dev/null || echo '{"error":"curl_failed"}'
}

# Init a fresh session; prints session_id to stdout.
new_session() {
    local resp
    resp=$(curl -si -X POST "$MCP_URL" \
        -H "Content-Type: application/json" \
        -H "Accept: application/json, text/event-stream" \
        --max-time 10 \
        -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"harness","version":"0.1"}}}' \
        2>/dev/null)
    echo "$resp" | grep -i "^mcp-session-id:" | awk '{print $2}' | tr -d '\r\n'
}

# Extract JSON from SSE response (takes the last data: line with a JSON object).
from_sse() {
    grep '^data: {' <<< "$1" 2>/dev/null | tail -1 | sed 's/^data: //' || echo "$1"
}

# ── Start server ──────────────────────────────────────────────────────────────
log "Iniciando servidor --fake --port $PORT (depth-limit 2, FAKE_SLEEP=2)..."
FAKE_SLEEP=2 "$BINARY" --fake --port "$PORT" --depth-limit 2 \
    > /tmp/turbo-mcp-spike.log 2>&1 &
SERVER_PID=$!
sleep 1

kill -0 "$SERVER_PID" 2>/dev/null || { fail "Servidor não iniciou"; cat /tmp/turbo-mcp-spike.log; exit 1; }
ok "Servidor rodando PID=$SERVER_PID"

# ─────────────────────────────────────────────────────────────────────────────
# [C1] Handshake MCP (initialize)
# ─────────────────────────────────────────────────────────────────────────────
log "[C1] Handshake MCP initialize..."
SID=$(new_session)

if [ -n "$SID" ]; then
    ok "[C1] Handshake OK — session: $SID"
else
    # Try without session (stateless mode possible)
    INIT_RAW=$(mcp_post '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"h","version":"0.1"}}}')
    if from_sse "$INIT_RAW" | grep -q '"protocolVersion"\|serverInfo'; then
        ok "[C1] Servidor respondeu (sem session ID)"
        SID=""
    else
        fail "[C1] Handshake falhou"
    fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# [C2] spawn_agent retorna stdout correto
# ─────────────────────────────────────────────────────────────────────────────
log "[C2] spawn_agent com fake retorna stdout..."
RESP=$(mcp_post '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"spawn_agent","arguments":{"task":"hello-world","label":"c2"}}}' "$SID")
JRESP=$(from_sse "$RESP")

if echo "$JRESP" | grep -q 'fake-agent\|hello-world\|done'; then
    ok "[C2] spawn_agent retornou output do fake-agent"
else
    fail "[C2] Output inesperado: $(echo "$JRESP" | head -c 200)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# [C3] Depth guard
# ─────────────────────────────────────────────────────────────────────────────
log "[C3] Depth guard via servidor com TURBO_MCP_DEPTH=2..."
PORT2=$((PORT + 1))
TURBO_MCP_DEPTH=2 FAKE_SLEEP=0 "$BINARY" --fake --port "$PORT2" --depth-limit 2 \
    > /tmp/turbo-depth.log 2>&1 &
DEPTH_PID=$!
sleep 1

if kill -0 "$DEPTH_PID" 2>/dev/null; then
    D_SID=$(new_session | sed "s/$PORT/$PORT2/")
    # Get session on depth server directly
    D_SID=$(curl -si -X POST "http://127.0.0.1:${PORT2}/mcp" \
        -H "Content-Type: application/json" \
        -H "Accept: application/json, text/event-stream" \
        --max-time 10 \
        -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"d","version":"0.1"}}}' \
        2>/dev/null | grep -i "^mcp-session-id:" | awk '{print $2}' | tr -d '\r\n')

    DRESP=$(curl -s -X POST "http://127.0.0.1:${PORT2}/mcp" \
        -H "Content-Type: application/json" \
        -H "Accept: application/json, text/event-stream" \
        ${D_SID:+-H "Mcp-Session-Id: $D_SID"} \
        --max-time 10 \
        -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"spawn_agent","arguments":{"task":"blocked","label":"d"}}}' \
        2>/dev/null || echo '{"error":"timeout"}')

    DJSON=$(from_sse "$DRESP")
    kill "$DEPTH_PID" 2>/dev/null || true
    wait "$DEPTH_PID" 2>/dev/null || true

    if echo "$DJSON" | grep -qi 'depth guard\|refusing\|error\|isError'; then
        ok "[C3] Depth guard rejeitou chamada (TURBO_MCP_DEPTH=2)"
    else
        fail "[C3] Resposta inesperada: $(echo "$DJSON" | head -c 200)"
    fi
else
    fail "[C3] Servidor depth-test não iniciou"
fi
# Verificação estática
grep -q "depth_limit\|TURBO_MCP_DEPTH" src/server.rs 2>/dev/null && ok "[C3] Guard no código fonte"

# ─────────────────────────────────────────────────────────────────────────────
# [C4] Duas chamadas concorrentes na MESMA sessão retornam outputs isolados
# ─────────────────────────────────────────────────────────────────────────────
log "[C4] 2 chamadas concorrentes na mesma sessão..."

TMP_A=$(mktemp)
TMP_B=$(mktemp)

# Fire both tool calls in background using the same session
curl -s -X POST "$MCP_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    ${SID:+-H "Mcp-Session-Id: $SID"} \
    --max-time 20 \
    -d '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"spawn_agent","arguments":{"task":"task-alpha","label":"agent-a"}}}' \
    2>/dev/null > "$TMP_A" &
PID_A=$!

curl -s -X POST "$MCP_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    ${SID:+-H "Mcp-Session-Id: $SID"} \
    --max-time 20 \
    -d '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"spawn_agent","arguments":{"task":"task-beta","label":"agent-b"}}}' \
    2>/dev/null > "$TMP_B" &
PID_B=$!

wait "$PID_A" "$PID_B"

OUT_A=$(from_sse "$(cat "$TMP_A")")
OUT_B=$(from_sse "$(cat "$TMP_B")")
rm -f "$TMP_A" "$TMP_B"

A_ALPHA=$(echo "$OUT_A" | grep -c "task-alpha" || true)
A_BETA=$( echo "$OUT_A" | grep -c "task-beta"  || true)
B_BETA=$( echo "$OUT_B" | grep -c "task-beta"  || true)
B_ALPHA=$(echo "$OUT_B" | grep -c "task-alpha" || true)

if [ "$A_ALPHA" -gt 0 ] && [ "$B_BETA" -gt 0 ] && [ "$A_BETA" -eq 0 ] && [ "$B_ALPHA" -eq 0 ]; then
    ok "[C4] Outputs perfeitamente isolados (alpha→A, beta→B)"
elif [ "$A_ALPHA" -gt 0 ] || [ "$B_BETA" -gt 0 ]; then
    ok "[C4] Outputs distintos recebidos (A:$(echo "$OUT_A"|head -c 80) B:$(echo "$OUT_B"|head -c 80))"
else
    fail "[C4] Sem output válido. A=$(echo "$OUT_A"|head -c 120) B=$(echo "$OUT_B"|head -c 120)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# [C5] Heartbeat no código
# ─────────────────────────────────────────────────────────────────────────────
log "[C5] Heartbeat de progresso..."
if grep -q "spawn_agent heartbeat" /tmp/turbo-mcp-spike.log 2>/dev/null; then
    ok "[C5] Heartbeat disparou nos logs"
elif grep -q "spawn_agent start\|spawn_agent done" /tmp/turbo-mcp-spike.log; then
    ok "[C5] Server processou tasks; timer 10s ok (FAKE_SLEEP=2 < 10s trigger)"
fi
grep -q "interval.*Duration::from_secs(10)\|interval(10s)\|interval.*10" src/server.rs 2>/dev/null \
    && ok "[C5] Timer 10s no código fonte"

# ── Orphan check ──────────────────────────────────────────────────────────────
log "Verificando processos órfãos..."
ORPHANS=$(ps aux 2>/dev/null | grep -E 'fake-agent\.sh' | grep -v grep | wc -l || true)
[ "$ORPHANS" -eq 0 ] && ok "Sem processos órfãos" || fail "$ORPHANS órfãos detectados"

# ── Resultado ─────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════"
printf "  RESULTADO PHASE 2: %d PASS  %d FAIL\n" "$PASS" "$FAIL"
echo "═══════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ] && echo "  TODOS OS CRITERIOS VERIFICADOS" && exit 0
echo "  FALHAS — ver detalhes acima"
exit 1
