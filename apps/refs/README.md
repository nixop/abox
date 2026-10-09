# Reference voice agent and avatar in the abox Codespace

Two services by the course author, built from their (private) sources into `/workspaces/bin` in the Codespace and run next to the KinD cluster. The ghcr.io images and charts need `read:packages` on the author's packages, which the lab token does not have, so the binaries are built from the clones (`go build`, CGO off, Go 1.27).

| service | source | listens | talks to |
|---|---|---|---|
| voice-agent | `github.com/den-vasyliev/voice-agent` (Go, Gemini Live, MCP + A2A tools) | `:8081` | kagent A2A (`memory-eval-both`, `k8s-agent`) via the agentgateway LB; `qdrant-mcp` (`vector_find`) via port-forward 3101 |
| avatar | `github.com/den-vasyliev/avatar` (Go, Runway realtime avatars, MCP tools as `backend_rpc`) | `:8080` | `qdrant-mcp` (3101) and `neo4j-mcp` (3104): the ADR-0003 memory stores |

`run-voice-agent.sh` and `run-avatar.sh` hold the flags; `voice-agent.instruction.md` replaces the voice agent's built-in (xray-memory) prompt with the delegation rules of this lab. Secrets come only from the environment: `GOOGLE_API_KEY` and `RUNWAYML_API_SECRET` as Codespaces secrets of `nixop/abox` (a secret added later is visible only after a stop/start of the Codespace).

## Build

```bash
# from the laptop, with the clones next to the lab:
tar czf - --exclude=.git voice-agent avatar | gh codespace ssh -c <codespace> -- 'mkdir -p /workspaces/refs /workspaces/bin && cd /workspaces/refs && tar xzf -'
# in the Codespace:
(cd /workspaces/refs/voice-agent && CGO_ENABLED=0 go build -o /workspaces/bin/voice-agent ./cmd/voice-agent)
(cd /workspaces/refs/avatar       && CGO_ENABLED=0 go build -o /workspaces/bin/avatar ./cmd/avatar)   # the Next.js UI is committed under cmd/avatar/ui/out
```

## Run

1. Cluster up, Flux `releases` reconcile disabled, branch manifests applied, `kagent-openai` secret created, port-forwards `qdrant-mcp 3101` and `neo4j-mcp 3104` running, memory ingested (scripted Relay memory: `reference-graph.cypher`, `relay-chunks.jsonl`, `relay-claims.jsonl`).
2. `GW=$(kubectl get svc -n agentgateway-system -o jsonpath='{.items[?(@.spec.type=="LoadBalancer")].status.loadBalancer.ingress[0].ip}') ./run-voice-agent.sh`
3. `AVATAR_ID=<runway custom avatar uuid>-id-relay ./run-avatar.sh`
4. Forward 8081 and 8080 from the Codespace (HTTPS, `https://<codespace>-8081.app.github.dev`), which is what the browser needs for the microphone and camera. The voice agent accepts any Host (`-allowed-host "*"`, lab only) because the forwarded host name is not known in advance.

## Demo

Voice: "What did we decide about the gateway timeout?" → `ask_memory_eval_both` → "25 seconds since the twenty-fourth of August". "Какие поды в kagent?" → `ask_k8s_agent`. "Bye" → `end_conversation`.

Avatar (PIN `admin:482913`): ask the same project question → `vector_find` / `read-cypher`; tell it "remember that on <date> we decided X" → `vector_store` into `relay-bge-m3`; end the call; start again and ask "what did I tell you last time" → `vector_find` finds the note. The note lands in the same collection the eval agents read, so `memory-eval-both` can quote it too.

## What differs from the author's defaults

- `-memory ""`: the voice agent's default memory substrate is xray-memory (code graph); this lab's memory is the Relay claims in Qdrant and Neo4j, so xray is off and `qdrant-mcp` is attached as an ordinary MCP server with one tool allowed.
- The prompt is replaced wholesale with `voice-agent.instruction.md`; the author's prompt is about code symbols and qualified names.
- The avatar's instructions name the lab's tools (`vector_find`, `vector_store`, `read-cypher`) instead of xray's `remember` / `recall` / `forget`.

Our own lighter implementations of the same two parts live in `apps/voice-agent` and `apps/avatar` (TypeScript; the avatar one works with Runway preset avatars and needs no custom avatar).

## Own apps instead of the reference binaries

`apps/voice-agent` (Node, Gemini Live, tools `list_agents` / `ask_agent`) replaces the
author's `voice-agent` binary on the same port: stop the binary, then
`cd apps/voice-agent && PORT=8081 GOOGLE_API_KEY=… node server.ts` (the model defaults to
`gemini-2.5-flash-native-audio-preview-12-2025`, the key is read from `GEMINI_API_KEY` or
`GOOGLE_API_KEY`). The system prompt carries the same rules as `voice-agent.instruction.md`,
including the topic-history rule for "previous decisions" questions. The browser page is
push-to-talk (hold the button) or typed text. `apps/avatar` was our own from the start; the
author's avatar server (`run-avatar.sh`) was not used in the demo.
