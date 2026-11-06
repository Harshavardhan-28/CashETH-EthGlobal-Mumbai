#!/usr/bin/env bash
# Starts the CashETH auth server (:4020) and MCP server (:4030) for the Claude Code demo, in one terminal.
# Builds first, refuses to start if either port is taken, prints each server's output with a prefix, waits until
# the MCP server has warmed its lender and stats caches, and stops both servers on Ctrl+C or if either exits.
#
#   pnpm servers                       # defaults below
#   CASHETH_LLM_PROVIDER=ollama CASHETH_LLM_MODEL=qwen3:8b pnpm servers
set -euo pipefail
cd "$(dirname "$0")/.."

PAID_API_ORIGIN="https://casheth-paid-apis-177290233934.asia-southeast1.run.app"
PAID_API_PAYEE="0.0.11333304"

for port in 4020 4030; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use (an earlier server?). Stop it first, e.g.: kill \$(lsof -t -iTCP:$port -sTCP:LISTEN)" >&2
    exit 1
  fi
done

echo "building…"
pnpm -s -r build

pids=()
stop() {
  trap - INT TERM EXIT
  echo
  echo "stopping servers…"
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap stop INT TERM EXIT

# Runs a server in the background with a coloured name prefix on every output line.
run() {
  local name="$1" colour="$2"; shift 2
  ( "$@" 2>&1 | sed -u "s/^/$(printf '\033[%sm' "$colour")[$name]$(printf '\033[0m') /" ) &
  pids+=("$!")
}

wait_for() {
  local url="$1" name="$2" tries=60
  until curl -s --max-time 2 "$url" >/dev/null 2>&1; do
    tries=$((tries - 1))
    if [ "$tries" -le 0 ]; then echo "$name did not come up at $url" >&2; exit 1; fi
    sleep 1
  done
}

run auth 36 env AUTH_DEMO_GRANT=true pnpm -s -F @casheth/auth start
wait_for http://127.0.0.1:4020/health "auth server"

run mcp 35 env \
  AGENT_KEYS_IN_PROCESS=true \
  CASHETH_LLM_PROVIDER="${CASHETH_LLM_PROVIDER:-heuristic}" \
  MERCHANT_ORIGINS="${MERCHANT_ORIGINS:-$PAID_API_PAYEE=$PAID_API_ORIGIN}" \
  pnpm -s -F @casheth/mcp start
wait_for http://127.0.0.1:4030/health "MCP server"

echo
echo "Both servers are up. Wait for '[mcp] read API ready' before running /casheth-demo; Ctrl+C stops both."
# Exit (and stop the other) as soon as either server dies.
while kill -0 "${pids[0]}" 2>/dev/null && kill -0 "${pids[1]}" 2>/dev/null; do sleep 2; done
echo "a server exited; stopping the other." >&2
exit 1
