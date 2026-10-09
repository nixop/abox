// Avatar backend: mints Runway realtime avatar sessions and serves the
// avatar's backend RPC tools, which delegate to kagent agents over A2A.
//
// Full memory loop: during the session the avatar answers project questions
// through `recall` (memory-eval-both) and stores explicit facts through
// `remember` (memory-writer). At the end of the session the whole exchange
// is sent to memory-writer as a transcript, so the next session can recall
// what was said. RUNWAYML_API_SECRET never leaves this process.
//
//   RUNWAYML_API_SECRET=... KAGENT_URL=http://172.18.0.5 node server.ts

import express from "express";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Runway from "@runwayml/sdk";
import type { RealtimeSessionCreateParams } from "@runwayml/sdk/resources/realtime-sessions";
import { createRpcHandler, type RpcHandler } from "@runwayml/avatars-node-rpc";
import { askAgent, listAgents } from "../voice-agent/kagent.ts";

const PORT = Number(process.env.PORT ?? 8788);
const MEMORY_AGENT = process.env.MEMORY_AGENT ?? "memory-eval-both";
const WRITER_AGENT = process.env.WRITER_AGENT ?? "memory-writer";
const here = dirname(fileURLToPath(import.meta.url));
const secret = process.env.RUNWAYML_API_SECRET;
const runway = secret ? new Runway({ apiKey: secret }) : null;

const PERSONALITY = `You are the spoken face of a team of kagent agents for the Relay webhook delivery project.
You do not know the project yourself: for any question about decisions, owners, timeouts, retries, documents or ADRs call recall;
for cluster questions (pods, deployments, Helm releases, metrics) call ask_agent with k8s-agent, helm-agent or observability-agent;
call list_agents if unsure. When the user tells you a new fact or decision to keep, call remember with one clear sentence
including the date they give or today's date. Repeat the tool's answer in the user's language in at most three sentences,
with the date and source when the answer has them. If a tool says something is not in memory, say exactly that.`;
const START = "Hi. I speak for the Relay team's agents. Ask me what was decided, who owns what, or tell me something to remember.";

const tools: RealtimeSessionCreateParams["tools"] = [
  { type: "backend_rpc", name: "list_agents", description: "List the kagent agents available for delegation.", parameters: [], timeoutSeconds: 8 },
  { type: "backend_rpc", name: "recall", description: "Ask the project memory a question (decisions, owners, timeouts, retries, documents, ADRs, open items).",
    parameters: [{ name: "question", type: "string", description: "The question, self-contained, in English", required: true }], timeoutSeconds: 8 },
  { type: "backend_rpc", name: "ask_agent", description: "Delegate a task to a named kagent agent over A2A (k8s-agent for pods and namespaces, helm-agent, observability-agent, promql-agent).",
    parameters: [{ name: "agent", type: "string", description: "Agent name", required: true }, { name: "task", type: "string", description: "The task, in English", required: true }], timeoutSeconds: 8 },
  { type: "backend_rpc", name: "remember", description: "Store a fact or decision the user wants kept in the project memory.",
    parameters: [{ name: "fact", type: "string", description: "One sentence in English with the date, who decided and what", required: true }], timeoutSeconds: 8 },
];

type Exchange = { t: string; tool: string; args: Record<string, unknown>; result: unknown };
const sessions = new Map<string, { handler: RpcHandler; log: Exchange[]; started: string }>();
const today = () => new Date().toISOString().slice(0, 10);

async function pollUntilReady(sessionId: string) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const s = await runway!.realtimeSessions.retrieve(sessionId);
    if (s.status === "READY") return s;
    if (s.status === "COMPLETED" || s.status === "FAILED" || s.status === "CANCELLED") throw new Error(`session ${s.status.toLowerCase()} before ready`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("session creation timed out");
}

const app = express();
app.use(express.json());
app.get("/api/health", (_req, res) => res.json({ ok: true, runway: Boolean(runway), kagent: process.env.KAGENT_URL ?? "http://172.18.0.5" }));
app.get("/api/avatar/status/:id", async (req, res) => {
  if (!runway) { res.status(503).json({ error: "no runway secret" }); return; }
  try { res.json(await runway.realtimeSessions.retrieve(req.params.id)); } catch (e) { res.status(502).json({ error: e instanceof Error ? e.message : String(e) }); }
});
app.get("/api/agents", async (_req, res) => { try { res.json(await listAgents()); } catch (e) { res.status(502).json({ error: String(e) }); } });

app.post("/api/avatar/connect", async (req, res) => {
  if (!runway) { res.status(503).json({ error: "RUNWAYML_API_SECRET is not set on the server" }); return; }
  const avatarId = process.env.AVATAR_ID || (req.body?.avatarId as string) || "human-resource"; // the server decides which avatar; the page only asks
  try {
    const { id: sessionId } = await runway.realtimeSessions.create({
      model: "gwm1_avatars",
      avatar: (process.env.AVATAR_TYPE === "custom" || /^[0-9a-f-]{36}$/i.test(avatarId))
        ? { type: "custom", avatarId }
        : { type: "runway-preset", presetId: avatarId as RealtimeSessionCreateParams.RunwayPreset["presetId"] },
      personality: PERSONALITY,
      startScript: START,
      tools,
      maxDuration: 900,
    });
    const session = await pollUntilReady(sessionId);
    const log: Exchange[] = [];
    // Runway caps a backend RPC at 8 s and the avatar retries the same call
    // when it times out, while the memory agents take 5-30 s. So every call
    // runs to completion once, keyed by tool + args; a retry gets the cached
    // promise, and a call that is not done in 7 s returns a "still working"
    // result so the next retry collects the real answer.
    const inflight = new Map<string, Promise<Record<string, unknown>>>();
    const SOFT_DEADLINE_MS = 7000;
    const record = (tool: string) => async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const key = tool + ":" + JSON.stringify(args);
      let p = inflight.get(key);
      if (!p) { p = run(tool, args); inflight.set(key, p); p.finally(() => setTimeout(() => inflight.delete(key), 120_000)); }
      const timer = new Promise<Record<string, unknown>>((r) => setTimeout(() => r({ status: "pending", note: "The agent is still answering. Tell the user you are checking and call the same tool again with the same arguments in a few seconds." }), SOFT_DEADLINE_MS));
      return Promise.race([p, timer]);
    };
    const run = async (tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const t = new Date().toISOString();
      let result: Record<string, unknown>;
      try {
        if (tool === "list_agents") result = { agents: await listAgents() };
        else if (tool === "recall") result = { answer: await askAgent(MEMORY_AGENT, String(args.question ?? "") + " Answer in at most four short sentences, no markdown; include the date and source file.") };
        else if (tool === "ask_agent") result = { answer: await askAgent(String(args.agent ?? ""), String(args.task ?? "")) };
        else if (tool === "remember") result = { stored: await askAgent(WRITER_AGENT, `Ingest this note into memory. Source file: avatar/${today()}-session.txt. Date: ${today()}. Speaker: the user (avatar session).\n\n${String(args.fact ?? "")}\n\nWrite it as a claim following your rules and report what you wrote.`) };
        else result = { error: `unknown tool ${tool}` };
      } catch (e) { result = { error: e instanceof Error ? e.message : String(e) }; }
      log.push({ t, tool, args, result });
      console.log(t, sessionId.slice(0, 8), tool, JSON.stringify(args).slice(0, 120), "->", JSON.stringify(result).slice(0, 160));
      return result;
    };
    const handler = await createRpcHandler({
      apiKey: secret!,
      sessionId,
      tools: { list_agents: record("list_agents"), recall: record("recall"), ask_agent: record("ask_agent"), remember: record("remember") },
      onDisconnected: async () => {
        try { const st = await runway!.realtimeSessions.retrieve(sessionId); console.log("rpc disconnected", sessionId, JSON.stringify(st).slice(0, 400)); }
        catch (e) { console.log("rpc disconnected", sessionId, "status lookup failed:", e instanceof Error ? e.message : String(e)); }
      },
      onError: (e: Error) => console.error("rpc error", e.message),
    });
    sessions.set(sessionId, { handler, log, started: new Date().toISOString() });
    console.log(new Date().toISOString(), "session ready", sessionId, "avatar", avatarId);
    res.json({ sessionId, sessionKey: session.sessionKey });
  } catch (e) {
    console.error("connect failed", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// End of session. What the user asked to keep was stored by `remember` as it
// happened. Recalled answers are not new claims (ADR-0003: the agent writes
// what the sources do not already hold), so the session itself becomes one
// note: which questions were asked and which facts were stored, written as a
// single fact claim with no decision, open-item or meeting nodes. Writing the
// whole exchange back through memory-writer duplicated existing decisions
// under new keys dated the session day; that is why this is narrow.
app.post("/api/avatar/end", async (req, res) => {
  const sessionId = String(req.body?.sessionId ?? "");
  const s = sessions.get(sessionId);
  if (!s) { res.status(404).json({ error: "unknown session" }); return; }
  sessions.delete(sessionId);
  const remembered = s.log.filter((x) => x.tool === "remember").map((x) => String(x.args.fact ?? ""));
  const asked = s.log.filter((x) => x.tool === "recall" || x.tool === "ask_agent").map((x) => String(x.args.question ?? x.args.task ?? "")).filter(Boolean);
  if (!remembered.length && !asked.length) { res.json({ remembered: false, reason: "no tool calls in this session" }); return; }
  const day = s.started.slice(0, 10);
  const note = `On ${day} the user had an avatar session with the Relay memory agents.` +
    (asked.length ? ` They asked: ${[...new Set(asked)].slice(0, 8).map((q) => `"${q}"`).join("; ")}.` : "") +
    (remembered.length ? ` They asked to remember: ${remembered.map((f) => `"${f}"`).join("; ")}.` : "");
  try {
    const report = await askAgent(WRITER_AGENT, `Write exactly ONE claim of kind fact into the vector store (vector_store) with this text, source file avatar/${day}-session.txt, date ${day}, speaker "user (avatar session)". Do not write any Decision, OpenItem or Meeting node and do not extract decisions from the text: the questions in it were answered from existing memory and the facts to remember were already stored. Report the claim id.

${note}`);
    res.json({ remembered: true, calls: s.log.length, stored: remembered.length, asked: asked.length, report });
  } catch (e) { res.status(502).json({ remembered: false, error: e instanceof Error ? e.message : String(e) }); }
});

const dist = join(here, "dist");
if (existsSync(dist)) { app.use(express.static(dist)); app.get("*", (_req, res) => res.sendFile(join(dist, "index.html"))); }
app.listen(PORT, () => console.log(`avatar backend on http://localhost:${PORT} (runway ${runway ? "configured" : "NO SECRET"}, memory ${MEMORY_AGENT}, writer ${WRITER_AGENT})`));
