#!/usr/bin/env bash
# Run the reference avatar server (github.com/den-vasyliev/avatar, built from
# source into /workspaces/bin) with this lab's memory stores as its MCP
# servers: qdrant-mcp (vector_store, vector_find) and neo4j-mcp (get-schema,
# read-cypher, write-cypher). The avatar has no tools of its own; the lines
# below tell it when to use ours, which is the full memory loop of ADR-0003:
# what the user says is stored as claims and found again next session.
#
#   AVATAR_ID=<runway custom avatar uuid>-id-relay ./run-avatar.sh   # :8080, PIN admin:482913
#
# RUNWAYML_API_SECRET comes from the environment (Codespaces secret). The
# server refuses to start without it and without at least one --avatar; a
# Runway *custom* avatar UUID is required, presets are not accepted here.
set -euo pipefail
BIN="${BIN:-/workspaces/bin/avatar}"
: "${RUNWAYML_API_SECRET:?RUNWAYML_API_SECRET is not set (Codespaces secret; stop and start the Codespace after adding it)}"
: "${AVATAR_ID:?AVATAR_ID is not set (Runway custom avatar UUID, optionally with -id-<name>)}"
PIN="${PIN:-admin:482913}"
TODAY="$(date +%F)"

exec "$BIN" \
  --http-address ":8080" --log-level debug --cors-origin "*" \
  --mobile-pin "$PIN" \
  --avatar "$AVATAR_ID" \
  --mcp-server "memory=http://127.0.0.1:3101/mcp" \
  --mcp-server "graph=http://127.0.0.1:3104/mcp" \
  --instructions "You speak for the Relay webhook delivery project team and know nothing about it yourself: every project fact comes from the tools." \
  --instructions "For any question about decisions, owners, timeouts, retries, SLO, open items, documents or ADRs, first call vector_find with the question in English; it returns claims and document chunks with dates and source files. Prefer the newest claim with status active; a claim marked superseded is history." \
  --instructions "For 'what is the current decision on X' use read-cypher: MATCH (d:Decision)-[:ABOUT]->(:Topic {key:'topic:<slug>'}) WHERE NOT (d)<-[:SUPERSEDES]-() AND d.status <> 'rejected' RETURN d.text, d.date, d.source. Topic slugs: iac, gateway, timeouts, retries, idempotency, database, compute, slo, cost, security, cutover. Dates are ISO strings; never call date()." \
  --instructions "When the person tells you something to keep, or states a decision or a fact, call vector_store with the text as one clear English sentence including today's date ($TODAY) and who said it, and metadata {source: 'avatar', date: '$TODAY', kind: 'note'}. Do this for what the person said, never for what a tool returned." \
  --instructions "Anything about an earlier conversation ('do you remember', 'last time', 'what did I tell you') is answered by vector_find with the words of the question; say plainly when nothing comes back." \
  --instructions "Speak the answer in the person's language in at most three sentences, with the date and the source meeting or document when the tool gave them. If the tools return nothing, say the memory has nothing on it; do not invent." \
  --instructions "Before hanging up, if the person told you anything worth keeping, store a one-sentence summary with vector_store the same way." \
  "$@"
