#!/usr/bin/env bash
# Own-apps variant of part E: replaces the author's voice-agent binary on :8081.
# Reads the Gemini key from the Codespaces secrets file; nothing is printed.
set -euo pipefail
cd "$(dirname "$0")"
J=/workspaces/.codespaces/shared/user-secrets-envs.json
export GOOGLE_API_KEY="${GOOGLE_API_KEY:-$(python3 -c "import json;print(json.load(open('$J'))['GOOGLE_API_KEY'])")}"
P=$(sudo ss -ltnp | grep ":${PORT:-8081} " | grep -o "pid=[0-9]*" | cut -d= -f2 || true)
[ -n "$P" ] && kill "$P" && sleep 1
[ -d node_modules ] || npm install --silent
PORT="${PORT:-8081}" exec node server.ts
