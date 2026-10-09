// Browser side: push-to-talk microphone -> 16 kHz PCM16 over WebSocket;
// 24 kHz PCM16 back from the server, played through the Web Audio API.
const $ = (id) => document.getElementById(id);
const log = (cls, text) => { const d = document.createElement("div"); d.className = "m " + cls; d.textContent = text; $("log").appendChild(d); $("log").scrollTop = $("log").scrollHeight; return d; };

let ws, audioCtx, micStream, workletNode, playHead = 0, agentLine = null, youLine = null;

async function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { $("state").textContent = "connected"; $("mic").disabled = false; $("text").disabled = false; $("send").disabled = false; $("connect").textContent = "Disconnect"; };
  ws.onclose = () => { $("state").textContent = "disconnected"; $("mic").disabled = true; $("text").disabled = true; $("send").disabled = true; $("connect").textContent = "Connect"; stopMic(); };
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) { play(ev.data); return; }
    const f = JSON.parse(ev.data);
    if (f.type === "transcript") {
      if (f.who === "agent") { if (!agentLine) agentLine = log("agent", "agent: "); agentLine.textContent += f.text; }
      else { if (!youLine) youLine = log("you", "you: "); youLine.textContent += f.text; }
    } else if (f.type === "turn_complete") { agentLine = null; youLine = null; }
    else if (f.type === "interrupted") { playHead = 0; agentLine = null; }
    else if (f.type === "tool") { log("tool", `→ ${f.name}(${JSON.stringify(f.args)})`); }
    else if (f.type === "tool_result") { const r = f.result; log("tool", `← ${f.name}: ${typeof r === "string" ? r : JSON.stringify(r).slice(0, 600)}`); }
    else if (f.type === "status") { log("status", f.text); }
    else if (f.type === "error") { log("err", f.text); }
  };
}

function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
}

// playback: PCM16 LE, 24 kHz, mono; chunks are scheduled back to back
function play(buf) {
  ensureAudio();
  const i16 = new Int16Array(buf); const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  const ab = audioCtx.createBuffer(1, f32.length, 24000); ab.copyToChannel(f32, 0);
  const src = audioCtx.createBufferSource(); src.buffer = ab; src.connect(audioCtx.destination);
  const now = audioCtx.currentTime; if (playHead < now) playHead = now;
  src.start(playHead); playHead += ab.duration;
}

// capture: AudioWorklet downsamples the microphone to 16 kHz PCM16
const workletSrc = `
class Pcm16 extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.ratio = sampleRate / 16000; this.acc = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]; if (!ch) return true;
    const out = [];
    for (let i = 0; i < ch.length; i++) { this.acc += 1; if (this.acc >= this.ratio) { this.acc -= this.ratio; out.push(ch[i]); } }
    if (out.length) { const i16 = new Int16Array(out.length); for (let i = 0; i < out.length; i++) i16[i] = Math.max(-1, Math.min(1, out[i])) * 32767; this.port.postMessage(i16.buffer, [i16.buffer]); }
    return true;
  }
}
registerProcessor("pcm16", Pcm16);`;

async function startMic() {
  ensureAudio();
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  await audioCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([workletSrc], { type: "text/javascript" })));
  const src = audioCtx.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(audioCtx, "pcm16");
  workletNode.port.onmessage = (e) => { if (ws && ws.readyState === 1) ws.send(e.data); };
  src.connect(workletNode); workletNode.connect(audioCtx.destination); // destination keeps the graph alive; worklet outputs silence
  $("mic").classList.add("live"); $("mic").textContent = "Listening… release to send";
}
function stopMic() {
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  if (workletNode) { workletNode.disconnect(); workletNode = null; }
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "audio_end" }));
  $("mic").classList.remove("live"); $("mic").textContent = "Hold to talk";
}

$("connect").onclick = () => { if (ws && ws.readyState === 1) ws.close(); else connect(); };
$("mic").onpointerdown = (e) => { e.preventDefault(); startMic().catch((err) => log("err", "microphone: " + err.message)); };
$("mic").onpointerup = $("mic").onpointerleave = () => { if (micStream) stopMic(); };
$("send").onclick = () => { const t = $("text").value.trim(); if (!t || !ws) return; ensureAudio(); ws.send(JSON.stringify({ type: "text", text: t })); $("text").value = ""; };
$("text").onkeydown = (e) => { if (e.key === "Enter") $("send").onclick(); };
fetch("/agents").then((r) => r.json()).then((a) => { $("agents").textContent = "agents: " + a.map((x) => x.name).join(", "); }).catch(() => {});
