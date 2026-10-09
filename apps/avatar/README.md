# avatar: a Runway realtime avatar with a full memory loop

The avatar (Runway `gwm1_avatars`, preset face and voice) talks to the user; its backend RPC tools run on this server and delegate to kagent agents over A2A:

| tool | goes to | used for |
|---|---|---|
| `recall(question)` | `memory-eval-both` | decisions, owners, timeouts, retries, documents, ADRs, open items |
| `ask_agent(agent, task)` | any kagent agent (`k8s-agent`, `helm-agent`, …) | cluster questions |
| `remember(fact)` | `memory-writer` | a fact or decision the user asks to keep |
| `list_agents()` | kagent REST | what can be delegated |

Memory loop: every tool call is logged per session; when the call ends the browser posts `/api/avatar/end` and the backend sends the session log to `memory-writer` as a transcript (`avatar/<date>-session.txt`). The next session can `recall` it. The user never sees `RUNWAYML_API_SECRET`; sessions are minted server-side and polled until `READY`.

## Run in the abox Codespace

1. Codespaces secrets for `nixop/abox`: `RUNWAYML_API_SECRET` (Runway developer account, dev.runwayml.com). Restart the Codespace after adding it.
2. `cd apps/avatar && npm install`.
3. Backend: `npm run server` (port 8788; env `KAGENT_URL`, `AVATAR_ID` default `human-resource`, `MEMORY_AGENT`, `WRITER_AGENT`). Frontend in dev: `npm run dev` (port 5173, proxies `/api`); or `npm run build` and open 8788 directly.
4. Open the forwarded HTTPS port in the browser (camera and microphone permissions), press Start call.

Presets available: `game-character`, `music-superstar`, `game-character-man`, `cat-character`, `influencer`, `tennis-coach`, `human-resource`, `fashion-designer`, `cooking-teacher`. Client events (tool calls) need a preset voice, which presets have.

## Demo script (full memory loop)

1. "What is the current gateway timeout?" → `recall` → "25 s since 2026-08-24".
2. "Remember that on 2026-10-10 we decided to raise the DLQ alert threshold to 50 messages; Ivan owns it." → `remember` → memory-writer stores the claim.
3. End the call → the session log goes to memory-writer; the page shows its report.
4. Start a new call: "What did we decide about the DLQ alert threshold?" → `recall` finds the claim from the previous session.

## Notes

- `backend_rpc` tools are executed by `@runwayml/avatars-node-rpc` over a connection the server opens per session; a tool call that takes longer than `timeoutSeconds` is reported to the avatar as failed, so the memory agents' 5–30 s answers fit but a slow `k8s-agent` call may not.
- The avatar's conversation model is Runway's; the personality text in `server.ts` tells it to delegate rather than answer from its own knowledge, the same rule as the voice agent.
- Without `RUNWAYML_API_SECRET` the backend starts, `/api/agents` and the kagent path work, and `/api/avatar/connect` returns 503.
