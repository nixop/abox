#!/usr/bin/env bash
# Run the reference voice-agent (github.com/den-vasyliev/voice-agent, built
# from source into /workspaces/bin) against this cluster's kagent agents and
# memory MCP servers. Nothing here is a secret: the Gemini key is read from the
# GOOGLE_API_KEY variable (a Codespaces secret), never from a flag.
#
#   GW=172.18.0.5 ./run-voice-agent.sh          # listens on :8081
#
# Prerequisites: port-forwards to qdrant-mcp (3101) and neo4j-mcp (3104), the
# agentgateway LoadBalancer IP in GW, and the kagent agents memory-eval-both
# and k8s-agent deployed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="${BIN:-/workspaces/bin/voice-agent}"
GW="${GW:-172.18.0.5}"
CARD="${CARD:-.well-known/agent-card.json}"   # kagent's A2A agent card path, relative to /api/a2a/kagent/<agent>/
: "${GOOGLE_API_KEY:?GOOGLE_API_KEY is not set (Codespaces secret; stop and start the Codespace after adding it)}"

exec "$BIN" \
  -addr ":8081" -allowed-host "*" -backend aistudio -api-key-env GOOGLE_API_KEY \
  ${VOICE_MODEL:+-model "$VOICE_MODEL"} \
  -memory "" \
  -mcp "memory=http://127.0.0.1:3101/mcp" -mcp-tools "memory=vector_find" \
  -a2a "memory-eval-both=http://$GW/api/a2a/kagent/memory-eval-both/$CARD" \
  -a2a-description "memory-eval-both=The Relay project memory: decisions, owners, timeouts, retries, SLO, open items, documents, ADRs, with dates and sources." \
  -a2a "k8s-agent=http://$GW/api/a2a/kagent/k8s-agent/$CARD" \
  -a2a-description "k8s-agent=Kubernetes cluster operations: pods, deployments, namespaces, logs, events." \
  -instruction-file "$HERE/voice-agent.instruction.md" \
  -debug "$@"
