// Checks the voice filters of the SoundCheck plugin's Streamlabs build (0.5.1+) in a running
// Streamlabs Desktop: that Streamlabs can add both filter kinds through SourceFiltersService,
// that the analyzer records the source it sits on (found by the source's libobs name, its
// sourceId), and that the voice EQ takes and keeps its settings. Everything it adds goes again,
// and the source's filters are compared with how they were. Talk into the mic while it runs;
// without a source name it takes the mic input that is loudest when it starts.
// Install soundcheck-streamlabs.dll and restart Streamlabs (or let verify-streamlabs-plugin.mjs
// load it) first.
//   node tools/verify-streamlabs-voice.mjs ["source name"]
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
  let buffer = "", nextId = 1; const pending = new Map();
  socket.on("data", (c) => { buffer += c.toString(); let i; while ((i = buffer.indexOf("\n")) >= 0) { const m = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } } });
  const once = (resource, method, args) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: { resource, args } }) + "\n"); setTimeout(() => reject(new Error("timeout")), 10000); });
  // Streamlabs limits how many requests it takes per second; wait and try again when it says so.
  const request = async (resource, method, ...args) => {
    for (let attempt = 0; ; attempt++) {
      try { return await once(resource, method, args); } catch (e) { if (attempt > 10 || !/rate|limit/i.test(e.message)) throw e; await wait(600); }
    }
  };
  return { ready: new Promise((r) => socket.once("connect", r)), request, end: () => socket.end() };
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
const FILTERS = "SourceFiltersService";

const sl = slobs(); await sl.ready;
const info = await control("GetInfo").catch(() => null);
check(info?.ok === true, "plugin answers", info ? `version ${info.pluginVersion}` : "no control port; is the plugin loaded?");
if (!info?.ok) process.exit(1);

const audio = await sl.request("AudioService", "getSources");
const wanted = process.argv[2];
// Without a name, the mic input that hears the most right now (a "default device" one can be silent).
const levels = new Map(((await control("GetSourceLevels")).inputs ?? []).map((i) => [i.name, Math.max(0, ...i.levels.map((l) => l.peak))]));
const inputs = audio.filter((a) => /input_capture/.test(a.sourceId)).sort((x, y) => (levels.get(y.sourceId) ?? 0) - (levels.get(x.sourceId) ?? 0));
const target = wanted ? audio.find((a) => a.name === wanted) : inputs[0];
if (!target) {
  console.log(`No audio source ${wanted ? `named "${wanted}"` : "that looks like a mic"}; pass its name. Sources: ${audio.map((a) => a.name).join(", ")}`);
  process.exit(1);
}
const id = target.sourceId;
console.log(`Using "${target.name}" (${id})`);
const chain = async () => (await sl.request(FILTERS, "getFilters", id)).map((f) => `${f.name}:${f.type}:${f.visible}`).join(" | ");
const before = await chain();

const ANALYZER = "SoundCheck 驗證分析";
const EQ = "SoundCheck 驗證 EQ";
try {
  // The analyzer, first in the chain, records the source as it comes in.
  await sl.request(FILTERS, "add", id, "soundcheck_voice_analyzer", ANALYZER, {});
  const list = await sl.request(FILTERS, "getFilters", id);
  const at = list.findIndex((f) => f.name === ANALYZER);
  check(at >= 0 && list[at].type === "soundcheck_voice_analyzer", "Streamlabs adds the analyzer filter", list.map((f) => f.type).join(", "));
  if (at > 0) await sl.request(FILTERS, "setOrder", id, ANALYZER, -at);
  check((await sl.request(FILTERS, "getFilters", id))[0]?.name === ANALYZER, "the analyzer moves to the top");

  const byName = await control("StartVoiceCapture", { source: target.name, seconds: 2 });
  check(byName.ok === false, "the display name doesn't find it (libobs uses the sourceId)", JSON.stringify(byName));
  const start = await control("StartVoiceCapture", { source: id, seconds: 2 });
  check(start.ok === true && start.sampleRate > 0, "StartVoiceCapture by sourceId", JSON.stringify(start));
  let from = 0, peak = 0, last;
  const started = Date.now();
  for (;;) {
    await wait(250);
    last = await control("ReadVoiceCapture", { source: id, from });
    if (!last.ok) break;
    from += last.frames;
    peak = Math.max(peak, last.peak);
    if ((!last.capturing && from >= last.total) || Date.now() - started > 6000) break;
  }
  check(last?.ok === true && from === last.target, "records the frames asked for", `${from} of ${last?.target} at ${last?.sampleRate} Hz in ${Date.now() - started} ms`);
  const decoded = Buffer.from(last?.data ?? "", "base64").length;
  check(decoded === last.frames * 4, "a read is float32 PCM", `${decoded} bytes for ${last.frames} frames`);
  check(peak > 0.0005, "the recording has sound (talk into the mic)", `peak ${peak.toFixed(4)}`);
  check((await control("StopVoiceCapture", { source: id })).ok === true, "StopVoiceCapture");

  // The voice EQ takes its settings, keeps them, and turns off and on.
  const settings = { hpf_freq: 80, mud_freq: 315, mud_gain: -3, mud_q: 1.4, presence_freq: 3150, presence_gain: 2, presence_q: 1, air_freq: 10000, air_gain: 0, deess_enabled: false };
  await sl.request(FILTERS, "add", id, "soundcheck_voice_eq", EQ, settings);
  check((await sl.request(FILTERS, "getFilters", id)).some((f) => f.name === EQ && f.type === "soundcheck_voice_eq"), "Streamlabs adds the voice EQ");
  await sl.request(FILTERS, "setSettings", id, EQ, { ...settings, mud_gain: -4.5 });
  const form = await sl.request(FILTERS, "getPropertiesFormData", id, EQ);
  const mud = form.find((p) => p.name === "mud_gain")?.value;
  check(mud === -4.5, "the voice EQ keeps new settings", `mud_gain ${mud}; fields: ${form.map((p) => p.name).join(", ")}`);
  await sl.request(FILTERS, "setVisibility", id, EQ, false);
  check((await sl.request(FILTERS, "getFilters", id)).find((f) => f.name === EQ)?.visible === false, "the voice EQ turns off");
} finally {
  for (const name of [EQ, ANALYZER]) await sl.request(FILTERS, "remove", id, name).catch(() => {});
}
const after = await chain();
check(after === before, "the source's filters are as they were", after || "(none)");
check((await control("GetInfo")).ok === true, "the plugin still answers");
sl.end();
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
