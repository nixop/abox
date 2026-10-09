# voice-agent: speak to kagent agents

Browser microphone → this Node backend → Gemini Live → kagent A2A. Gemini holds the conversation and the voice; it has two tools, `list_agents` and `ask_agent(agent, task)`, and the backend executes them against the cluster. Nothing is answered from the model's own knowledge: project questions go to `memory-eval-both`, cluster questions to `k8s-agent`, and so on (see the system prompt in `server.ts`).

## Run in the abox Codespace

1. Add `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) as a Codespaces secret for `nixop/abox` (GitHub → Settings → Codespaces → secrets). A secret added after the Codespace was created is only visible after a full stop and start of the Codespace.
2. `cd apps/voice-agent && npm install && npm start` (Node 22.6+ runs the `.ts` files directly). Env: `KAGENT_URL` (default `http://172.18.0.5`, the agentgateway LoadBalancer IP inside the Codespace), `GEMINI_LIVE_MODEL` (default `gemini-2.5-flash-native-audio-preview-12-2025`), `AGENTS` (optional comma list to restrict delegation), `PORT` (8787).
3. Open the forwarded port in the browser. Codespaces forwards it over HTTPS (`https://<codespace>-8787.app.github.dev`), which is what the microphone API needs; set the port to Public or stay signed in to GitHub.
4. Connect, hold the button and talk, or type a question in the box. The log shows both transcripts and every tool call with its result.

## Demo script

- "What did we decide about the gateway timeout?" → `ask_agent(memory-eval-both, …)` → "25 s since 2026-08-24, meetings/2026-08-24-weekly-sync.txt".
- "Кто сейчас владеет ретраями?" → the same agent, answered in Russian.
- "List the pods in the kagent namespace" → `ask_agent(k8s-agent, …)`.
- "Which agents can you delegate to?" → `list_agents`.

## Notes

- Audio formats: input 16 kHz PCM16 mono (downsampled in an AudioWorklet), output 24 kHz PCM16 from Gemini, played with the Web Audio API; an `interrupted` message drops the queued audio.
- agentgateway cannot proxy the stateful Gemini WebSocket, so the backend talks to Gemini directly; the key never reaches the browser.
- The memory agents answer from whatever memory is loaded in the cluster at the time (scripted or agentic Relay memory).
