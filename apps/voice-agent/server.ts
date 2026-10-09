// Voice agent: browser microphone -> this backend -> Gemini Live -> kagent A2A.
//
// The backend holds GEMINI_API_KEY and opens one Gemini Live session per
// browser connection. Gemini gets two tools, list_agents and ask_agent; when
// it calls them the backend executes the call against kagent and returns the
// answer, which Gemini then speaks. Audio in is 16 kHz PCM16 from the browser,
// audio out is 24 kHz PCM16 from Gemini, both forwarded as binary WebSocket
// frames. Transcripts of both sides are forwarded as JSON frames.
//
//   GEMINI_API_KEY=... KAGENT_URL=http://172.18.0.5 node server.ts
//
// agentgateway cannot proxy the stateful Gemini WebSocket, so this process
// talks to Gemini directly (TASK-0004 known trap).

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { GoogleGenAI, Modality, Type, type Session, type LiveServerMessage } from "@google/genai";
import { askAgent, listAgents } from "./kagent.ts";

const PORT = Number(process.env.PORT ?? 8787);
const MODEL = process.env.GEMINI_LIVE_MODEL ?? "gemini-3.8-live";
const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY or GOOGLE_API_KEY is not set (add it as a Codespaces secret and restart the Codespace)");
  process.exit(1);
}
const ai = new GoogleGenAI({ apiKey });
const here = dirname(fileURLToPath(import.meta.url));

const SYSTEM = `You are the voice front for a team of kagent agents running in a Kubernetes cluster.
You never answer project or cluster questions from your own knowledge: you delegate.
Rules:
- Call list_agents when you do not know which agent fits. Prefer: memory-eval-both for anything about the Relay project
  (decisions, owners, timeouts, retries, documents, ADRs); k8s-agent for pods, deployments, namespaces, logs; helm-agent for Helm releases;
  observability-agent or promql-agent for metrics.
- Call ask_agent with a precise task in English; the agent answers in text. Then say the answer back in the user's language, short, with the date and source if the agent gave them.
- If the agent says something is not in memory, say so; do not fill the gap.
- Keep spoken replies under three sentences unless the user asks for the full list.`;

const tools = [{
  functionDeclarations: [
    { name: "list_agents", description: "List the kagent agents available for delegation, with one-line descriptions.", parameters: { type: Type.OBJECT, properties: {} } },
    {
      name: "ask_agent",
      description: "Delegate a task to one kagent agent over A2A and return its text answer.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          agent: { type: Type.STRING, description: "Agent name, e.g. memory-eval-both or k8s-agent" },
          task: { type: Type.STRING, description: "The task or question for the agent, in English, self-contained" },
        },
        required: ["agent", "task"],
      },
    },
  ],
}];

async function runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === "list_agents") return { agents: await listAgents() };
  if (name === "ask_agent") {
    const agent = String(args.agent ?? ""); const task = String(args.task ?? "");
    try { return { agent, answer: await askAgent(agent, task) }; }
    catch (e) { return { agent, error: e instanceof Error ? e.message : String(e) }; }
  }
  return { error: `unknown tool ${name}` };
}

type Frame = { type: string; [k: string]: unknown };
const send = (ws: WebSocket, f: Frame) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(f)); };

async function handleBrowser(ws: WebSocket) {
  let session: Session | undefined;
  const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
  try {
    session = await ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: SYSTEM,
        tools,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      callbacks: {
        onopen: () => { log("gemini open"); send(ws, { type: "status", text: `Gemini Live connected (${MODEL})` }); },
        onmessage: async (m: LiveServerMessage) => {
          const sc = m.serverContent;
          if (sc?.interrupted) send(ws, { type: "interrupted" });
          if (sc?.inputTranscription?.text) send(ws, { type: "transcript", who: "you", text: sc.inputTranscription.text });
          if (sc?.outputTranscription?.text) send(ws, { type: "transcript", who: "agent", text: sc.outputTranscription.text });
          for (const part of sc?.modelTurn?.parts ?? []) {
            if (part.inlineData?.data && ws.readyState === ws.OPEN) ws.send(Buffer.from(part.inlineData.data, "base64"));
          }
          if (sc?.turnComplete) send(ws, { type: "turn_complete" });
          if (m.toolCall?.functionCalls?.length) {
            const functionResponses = [];
            for (const fc of m.toolCall.functionCalls) {
              const args = (fc.args ?? {}) as Record<string, unknown>;
              send(ws, { type: "tool", name: fc.name, args });
              log("tool", fc.name, JSON.stringify(args));
              const result = await runTool(fc.name ?? "", args);
              send(ws, { type: "tool_result", name: fc.name, result });
              functionResponses.push({ id: fc.id, name: fc.name, response: { result } });
            }
            session?.sendToolResponse({ functionResponses });
          }
        },
        onerror: (e: unknown) => { log("gemini error", e); send(ws, { type: "error", text: String((e as { message?: string })?.message ?? e) }); },
        onclose: (e: unknown) => { log("gemini closed", (e as { reason?: string })?.reason ?? ""); send(ws, { type: "status", text: "Gemini session closed" }); },
      },
    });
  } catch (e) {
    send(ws, { type: "error", text: `Gemini connect failed: ${e instanceof Error ? e.message : String(e)}` });
    ws.close(); return;
  }
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (!session) return;
    if (isBinary) { session.sendRealtimeInput({ audio: { data: data.toString("base64"), mimeType: "audio/pcm;rate=16000" } }); return; }
    const f = JSON.parse(data.toString()) as Frame;
    if (f.type === "text" && typeof f.text === "string") {
      send(ws, { type: "transcript", who: "you", text: f.text });
      session.sendClientContent({ turns: [{ role: "user", parts: [{ text: f.text }] }], turnComplete: true });
    } else if (f.type === "audio_end") {
      session.sendRealtimeInput({ audioStreamEnd: true });
    }
  });
  ws.on("close", () => { log("browser closed"); session?.close(); });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const file = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  if (file === "agents") {
    try { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(await listAgents())); }
    catch (e) { res.statusCode = 502; res.end(String(e)); }
    return;
  }
  try {
    const body = await readFile(join(here, "public", file));
    res.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html; charset=utf-8");
    res.end(body);
  } catch { res.statusCode = 404; res.end("not found"); }
});
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => { void handleBrowser(ws); });
server.listen(PORT, () => console.log(`voice-agent on http://localhost:${PORT} (model ${MODEL}, kagent ${process.env.KAGENT_URL ?? "http://172.18.0.5"})`));
