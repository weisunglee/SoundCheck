// Prints what Streamlabs Desktop's local API returns for the calls SoundCheck makes, so the
// field names in src/streamlabsAdapter.ts can be checked against a real install. Read-only.
// Run on the computer where Streamlabs runs:  node tools/inspect-streamlabs.mjs
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const path =
  process.platform === "win32" ? "\\\\.\\pipe\\slobs" : join(homedir(), "Library/Application Support/slobs-client/slobs.sock");

const socket = net.connect(path);
let buffer = "";
let nextId = 1;
const pending = new Map();
socket.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const message = JSON.parse(line);
    const p = pending.get(message.id);
    if (p) {
      pending.delete(message.id);
      message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result);
    }
  }
});
socket.on("error", (e) => {
  console.log(`Cannot connect to ${path}: ${e.message}. Is Streamlabs Desktop running?`);
  process.exit(1);
});

const request = (resource, method, ...args) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: { resource, args } }) + "\n");
  });

const show = (label, value) => console.log(`\n== ${label}\n${JSON.stringify(value, null, 1).slice(0, 2500)}`);

await new Promise((r) => socket.once("connect", r));
const scenes = await request("ScenesService", "getScenes");
show(`ScenesService.getScenes (${scenes.length} scenes, first one)`, scenes[0]);
show("ScenesService.activeSceneId", await request("ScenesService", "activeSceneId"));
const audio = await request("AudioService", "getSources");
show(`AudioService.getSources (${audio.length}, first two)`, audio.slice(0, 2));
const sources = await request("SourcesService", "getSources");
show(`SourcesService.getSources (${sources.length}, first two)`, sources.slice(0, 2));
const kinds = await request("SourcesService", "getAvailableSourcesTypesList");
show("audio-related source types", kinds.filter((k) => /audio|capture/i.test(k.value)));
const capture = sources.find((s) => /wasapi|coreaudio/.test(s.type));
if (capture) show(`${capture.name}: getSettings`, await request(capture.resourceId, "getSettings"));
console.log("\nfader check (db -> deflection):", audio.slice(0, 5).map((a) => `${a.name}: ${a.fader?.db?.toFixed?.(1)} dB / ${a.fader?.deflection}`).join("; "));
socket.end();
process.exit(0);
