import { useEffect, useRef, useState } from "react";
import { AvatarCall, AvatarVideo, ControlBar, UserVideo, useAvatarSession, useTranscript } from "@runwayml/avatars-react";
import "@runwayml/avatars-react/styles.css";

type Creds = { sessionId: string; sessionKey: string };
const AVATAR_ID = (import.meta as unknown as { env: Record<string, string> }).env.VITE_AVATAR_ID || "human-resource";

export default function App() {
  const [creds, setCreds] = useState<Creds | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [agents, setAgents] = useState<string[]>([]);

  useEffect(() => { fetch("/api/agents").then((r) => r.json()).then((a: Array<{ name: string }>) => setAgents(a.map((x) => x.name))).catch(() => {}); }, []);

  async function connect() {
    setBusy(true); setError(null); setReport(null);
    try {
      const res = await fetch("/api/avatar/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ avatarId: AVATAR_ID }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `server error ${res.status}`);
      setCreds(data);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const endedOnce = useRef(new Set<string>());
  async function ended(sessionId: string) {
    setCreds(null);
    if (endedOnce.current.has(sessionId)) return; // AvatarCall fires onEnd more than once
    endedOnce.current.add(sessionId);
    try {
      const res = await fetch("/api/avatar/end", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId }) });
      const data = await res.json();
      setReport(data.remembered ? `Remembered (${data.calls} tool calls). memory-writer: ${String(data.report).slice(0, 600)}` : `Nothing to remember: ${data.reason ?? data.error ?? ""}`);
    } catch (e) { setReport(`end failed: ${e instanceof Error ? e.message : String(e)}`); }
  }

  if (!creds) {
    return (
      <main className="page">
        <h2>Avatar for the Relay team's agents</h2>
        <p>Runway realtime avatar with backend RPC tools: <code>recall</code> (memory-eval-both), <code>ask_agent</code> (k8s-agent and others), <code>remember</code> (memory-writer). The session log is written to memory when the call ends.</p>
        <p className="muted">agents: {agents.join(", ") || "…"}</p>
        <button className="primary" onClick={connect} disabled={busy}>{busy ? "Creating session…" : "Start call"}</button>
        {error && <p className="err">{error}</p>}
        {report && <p className="report">{report}</p>}
      </main>
    );
  }

  return (
    <main className="page call">
      <AvatarCall avatarId={AVATAR_ID} sessionId={creds.sessionId} sessionKey={creds.sessionKey} onEnd={() => ended(creds.sessionId)} onError={(e: Error) => setError(e.message)}>
        <AvatarVideo />
        <UserVideo />
        <ControlBar />
        <Transcript />
      </AvatarCall>
      {error && <p className="err">{error}</p>}
    </main>
  );
}

function Transcript() {
  const transcript = useTranscript({ interim: true, bufferSize: 200 });
  const { state } = useAvatarSession();
  return (
    <aside className="transcript">
      <div className="muted">session: {state}</div>
      {transcript.map((e) => <div key={e.id}><b>{e.participantIdentity}:</b> {e.text}</div>)}
    </aside>
  );
}
