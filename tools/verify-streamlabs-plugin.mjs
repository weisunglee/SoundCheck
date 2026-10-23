// Checks the SoundCheck plugin's Streamlabs build in a running Streamlabs Desktop: loading,
// the control port and its token, per-source level meters, the tap (48 kHz stereo, once per
// moment), and pausing the
// stream audio (heartbeat, resume, watchdog) without touching Streamlabs' own track settings.
// Install soundcheck-streamlabs.dll into %APPDATA%\slobs-plugins\obs-plugins\64bit first; it is
// loaded only if it isn't answering already. Pausing silences the stream for about 3 seconds,
// so don't run it while live.
//   node tools/verify-streamlabs-plugin.mjs
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
const appdata = process.env.APPDATA;
const controlPath = path.join(appdata, "slobs-plugins", "data", "obs-plugins", "soundcheck-streamlabs", "control.json");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function slobs() {
  const socket = net.connect("\\\\.\\pipe\\slobs");
  socket.on("error", (e) => {
    console.log(`Cannot reach Streamlabs (${e.message}). Is Streamlabs Desktop running?`);
    process.exit(1);
  });
  let buffer = "", nextId = 1; const pending = new Map(); const subs = new Map();
  socket.on("data", (c) => { buffer += c.toString(); let i; while ((i = buffer.indexOf("\n")) >= 0) { const m = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } else if (m.result?._type === "EVENT") subs.get(m.result.resourceId)?.(m.result); } });
  const request = (resource, method, ...args) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: { resource, args } }) + "\n"); setTimeout(() => reject(new Error("timeout")), 10000); });
  return { ready: new Promise((r) => socket.once("connect", r)), request, subs, end: () => socket.end() };
}

function control(requestType, requestData = {}) {
  const { port, token } = JSON.parse(fs.readFileSync(controlPath, "utf8"));
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(JSON.stringify({ token, requestType, requestData }) + "\n"));
    let buf = "";
    s.on("data", (c) => { buf += c; const i = buf.indexOf("\n"); if (i >= 0) { s.end(); resolve(JSON.parse(buf.slice(0, i))); } });
    s.on("error", reject);
    setTimeout(() => reject(new Error("control timeout")), 5000);
  });
}

let failures = 0;
const check = (ok, label, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`); if (!ok) failures++; };

const sl = slobs(); await sl.ready;
const outputs = await sl.request("StreamingService", "getModel");
if (Object.values(outputs.status).some((o) => o.streaming !== "offline" || o.recording !== "offline")) {
  console.log("Streamlabs is streaming or recording; not running.");
  process.exit(1);
}
let loaded = false;
try { loaded = (await control("GetInfo")).ok === true; } catch {}
if (!loaded) {
  await sl.request("ObsUserPluginsService", "initializeModule", "soundcheck-streamlabs.dll");
  // The answer is a promise; wait for the control file to appear.
  for (let i = 0; i < 30 && !fs.existsSync(controlPath); i++) await wait(100);
}
check(fs.existsSync(controlPath), "control.json written", controlPath);
const info = await control("GetInfo");
check(info.ok === true, "GetInfo answers", JSON.stringify(info));
const bad = await new Promise((resolve) => { const { port } = JSON.parse(fs.readFileSync(controlPath, "utf8")); const s = net.connect(port, "127.0.0.1", () => s.write(JSON.stringify({ token: "nope", requestType: "GetInfo" }) + "\n")); let b = ""; s.on("data", (c) => { b += c; if (b.includes("\n")) { s.end(); resolve(JSON.parse(b)); } }); });
check(bad.ok === false && bad.error === "wrong token", "a wrong token is refused", JSON.stringify(bad));

// Level meters: every Streamlabs audio source (libobs names them by sourceId) gets a reading.
await control("GetSourceLevels");
await wait(500);
const meterAnswer = await control("GetSourceLevels");
const readings = new Map((meterAnswer.inputs ?? []).map((i) => [i.name, i.levels]));
const audioSources = await sl.request("AudioService", "getSources");
const unmetered = audioSources.filter((a) => !readings.has(a.sourceId)).map((a) => a.name);
check(meterAnswer.ok === true && unmetered.length === 0, "every audio source is metered", unmetered.length ? `missing: ${unmetered.join(", ")}` : `${readings.size} sources`);
const values = [...readings.values()].flat().flatMap((c) => [c.magnitude, c.peak, c.inputPeak]);
check(values.length > 0 && values.every((v) => typeof v === "number" && v >= 0 && v <= 4), "levels are 0..1 amplitudes", values.slice(0, 6).map((v) => v.toFixed(4)).join(" "));
const loudest = audioSources.map((a) => ({ name: a.name, peak: Math.max(0, ...(readings.get(a.sourceId) ?? []).map((c) => c.peak)) })).sort((x, y) => y.peak - x.peak)[0];
console.log(`info  loudest source in the last 0.5 s: ${loudest?.name} (${loudest ? (20 * Math.log10(loudest.peak || 1e-9)).toFixed(1) : "-"} dBFS)`);
let fast = 0;
for (let i = 0; i < 20; i++) if ((await control("GetSourceLevels")).ok) fast++;
check(fast === 20, "20 reads in a row answer", String(fast));

// Tap: start, read a second of audio, stop.
const tap = await control("StartTap");
check(tap.ok === true && tap.port > 0, "StartTap", JSON.stringify(tap));
if (tap.ok) {
  // Count for 3 s after a 1 s warm-up: 48 kHz stereo float is 384000 bytes a second.
  const bytes = await new Promise((resolve) => { let n = 0; let peak = 0; let counting = false; const s = net.connect(tap.port, "127.0.0.1"); s.on("data", (c) => { if (!counting) return; n += c.length; for (let i = 0; i + 4 <= c.length; i += 4) peak = Math.max(peak, Math.abs(c.readFloatLE(i))); }); setTimeout(() => (counting = true), 1000); setTimeout(() => { s.destroy(); resolve({ n, peak }); }, 4000); });
  const ratio = bytes.n / 3 / 384000;
  check(Math.abs(ratio - 1) < 0.05, "tap delivers the stream mix at 48 kHz, once", `${(bytes.n / 3).toFixed(0)} B/s, ratio ${ratio.toFixed(3)}, peak ${bytes.peak.toFixed(4)}`);
  check((await control("StopTap")).ok === true, "StopTap");
}

// Pause: libobs mixers change, Streamlabs' own record stays the same, heartbeat keeps it, resume restores.
const audio = await sl.request("AudioService", "getSources");
const before = audio.map((a) => `${a.name}:${a.audioMixers}`).join(" ");
check((await control("PauseStreamAudio", { timeoutMs: 3000 })).ok === true, "PauseStreamAudio");
check((await control("GetInfo")).streamAudioPaused === true, "reports paused");
await wait(1500);
check((await control("Heartbeat")).streamAudioPaused === true, "heartbeat keeps it paused");
const during = (await sl.request("AudioService", "getSources")).map((a) => `${a.name}:${a.audioMixers}`).join(" ");
check(during === before, "Streamlabs' own track settings untouched while paused", during);
check((await control("ResumeStreamAudio")).ok === true, "ResumeStreamAudio");
check((await control("GetInfo")).streamAudioPaused === false, "reports resumed");
// Watchdog: pause, send nothing, and the plugin restores by itself.
await control("PauseStreamAudio", { timeoutMs: 1000 });
await wait(2000);
check((await control("GetInfo")).streamAudioPaused === false, "watchdog restores without heartbeats");
const after = (await sl.request("AudioService", "getSources")).map((a) => `${a.name}:${a.audioMixers}`).join(" ");
check(after === before, "track settings same as before", after);

console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
sl.end(); process.exit(failures ? 1 : 0);
