// Small kagent client used by the voice agent and the avatar backend.
// Lists agents through the kagent REST API and delegates a task over A2A
// (JSON-RPC message/send at /api/a2a/kagent/<agent>/), both behind the
// agentgateway load balancer.

export type AgentInfo = { name: string; description: string };

const KAGENT_URL = process.env.KAGENT_URL ?? "http://172.18.0.5";
const AGENT_FILTER = (process.env.AGENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export async function listAgents(): Promise<AgentInfo[]> {
  const res = await fetch(`${KAGENT_URL}/api/agents`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`kagent /api/agents ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ agent?: { metadata?: { name?: string }; spec?: { description?: string } } }> };
  const all = (body.data ?? [])
    .map((x) => ({ name: x.agent?.metadata?.name ?? "", description: (x.agent?.spec?.description ?? "").slice(0, 160) }))
    .filter((a) => a.name);
  return AGENT_FILTER.length ? all.filter((a) => AGENT_FILTER.includes(a.name)) : all;
}

export async function askAgent(agent: string, task: string, timeoutMs = 120_000): Promise<string> {
  const body = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "message/send",
    params: { message: { role: "user", kind: "message", messageId: crypto.randomUUID(), parts: [{ kind: "text", text: task }] } },
  };
  const res = await fetch(`${KAGENT_URL}/api/a2a/kagent/${agent}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`A2A ${agent} ${res.status}`);
  const d = (await res.json()) as {
    error?: { message?: string };
    result?: { status?: { state?: string; message?: { parts?: Array<{ text?: string }> } }; artifacts?: Array<{ parts?: Array<{ text?: string }> }> };
  };
  if (d.error) throw new Error(`A2A ${agent}: ${d.error.message ?? "error"}`);
  const r = d.result ?? {};
  const text = (r.artifacts ?? []).flatMap((a) => a.parts ?? []).map((p) => p.text ?? "").join(" ").trim();
  if (text) return text;
  const statusText = (r.status?.message?.parts ?? []).map((p) => p.text ?? "").join(" ").trim();
  return statusText || `(agent ${agent} ended in state ${r.status?.state ?? "unknown"} without a text answer)`;
}
