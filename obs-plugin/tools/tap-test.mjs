// Validation for the SoundCheck plugin, run on the machine where OBS runs:
//   node tap-test.mjs [seconds] [track]
// Connects with the local obs-websocket settings, asks the plugin which tracks go
// to the stream, records that track's mix to tap-test.wav, and prints levels.
// Also records OBS's own per-source meters during the same window, so a silent
// recording can be told apart from a silent track.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import OBSWebSocket, { EventSubscription } from "obs-websocket-js";

const seconds = Number(process.argv[2] ?? 10);
const requestedTrack = process.argv[3] ? Number(process.argv[3]) : undefined;

function websocketConfigPath() {
  if (process.platform === "win32") return join(process.env.APPDATA, "obs-studio/plugin_config/obs-websocket/config.json");
  if (process.platform === "darwin") return join(homedir(), "Library/Application Support/obs-studio/plugin_config/obs-websocket/config.json");
  return join(homedir(), ".config/obs-studio/plugin_config/obs-websocket/config.json");
}

const config = JSON.parse(readFileSync(websocketConfigPath(), "utf8"));
console.log(`websocket config: enabled=${config.server_enabled} port=${config.server_port} auth=${config.auth_required}`);

const obs = new OBSWebSocket();
await obs.connect(`ws://127.0.0.1:${config.server_port}`, config.auth_required ? config.server_password : undefined, {
  eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters,
});

/** Highest peak OBS reported for each input while we record, as a 0..1 multiplier. */
const sourcePeaks = new Map();
let metering = false;
obs.on("InputVolumeMeters", ({ inputs }) => {
  if (!metering) return;
  for (const input of inputs) {
    // inputLevelsMul is [channel][magnitude, peak, inputPeak]; the peak is post-fader.
    const peak = Math.max(0, ...input.inputLevelsMul.map((ch) => ch[1]));
    sourcePeaks.set(input.inputName, Math.max(peak, sourcePeaks.get(input.inputName) ?? 0));
  }
});
const version = await obs.call("GetVersion");
console.log(`OBS ${version.obsVersion}, obs-websocket ${version.obsWebSocketVersion}`);

const vendor = (requestType, requestData = {}) =>
  obs.call("CallVendorRequest", { vendorName: "soundcheck", requestType, requestData }).then((r) => r.responseData);

const info = await vendor("GetInfo");
console.log("GetInfo:", JSON.stringify(info));

const tap = await vendor("StartTap", requestedTrack ? { track: requestedTrack } : {});
console.log("StartTap:", JSON.stringify(tap));
if (!tap.ok) process.exit(1);

const bytesPerSecond = tap.sampleRate * tap.channels * 4;
const target = bytesPerSecond * seconds;
const chunks = [];
let received = 0;
const startedAt = Date.now();
metering = true;

await new Promise((resolve, reject) => {
  const socket = net.connect(tap.port, "127.0.0.1");
  socket.on("data", (chunk) => {
    chunks.push(chunk);
    received += chunk.length;
    if (received >= target) socket.destroy(), resolve();
  });
  socket.on("error", reject);
  socket.on("close", resolve);
  setTimeout(() => (socket.destroy(), resolve()), (seconds + 3) * 1000);
});
const elapsed = (Date.now() - startedAt) / 1000;
metering = false;

console.log(`OBS per-source peaks during the recording (track ${tap.track} is the tapped one):`);
const { inputs } = await obs.call("GetInputList");
for (const { inputName } of inputs) {
  let tracks, muted;
  try {
    tracks = (await obs.call("GetInputAudioTracks", { inputName })).inputAudioTracks;
    muted = (await obs.call("GetInputMute", { inputName })).inputMuted;
  } catch {
    continue; // video-only input
  }
  const on = Object.entries(tracks).filter(([, v]) => v).map(([k]) => k).join(",") || "none";
  const peak = sourcePeaks.get(inputName) ?? 0;
  const peakDb = peak > 0 ? (20 * Math.log10(peak)).toFixed(1) : "-inf";
  console.log(`  ${inputName}: tracks=[${on}] muted=${muted} peak=${peakDb} dBFS${tracks[String(tap.track)] && !muted && peak > 0.001 ? "  <- should be audible on the tapped track" : ""}`);
}

console.log("StopTap:", JSON.stringify(await vendor("StopTap")));
await obs.disconnect();

const pcm = Buffer.concat(chunks).subarray(0, Math.min(received, target) - (Math.min(received, target) % 8));
const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
const frames = samples.length / tap.channels;
console.log(`received ${(frames / tap.sampleRate).toFixed(2)} s of audio in ${elapsed.toFixed(2)} s wall time`);

const dbfs = (v) => (v > 0 ? (20 * Math.log10(v)).toFixed(1) : "-inf");
const perSecond = tap.sampleRate * tap.channels;
for (let s = 0; s * perSecond < samples.length; s++) {
  const slice = samples.subarray(s * perSecond, (s + 1) * perSecond);
  let peak = 0, sum = 0;
  for (const v of slice) (peak = Math.max(peak, Math.abs(v))), (sum += v * v);
  console.log(`  ${String(s).padStart(2)}s  peak ${dbfs(peak).padStart(6)} dBFS  rms ${dbfs(Math.sqrt(sum / slice.length)).padStart(6)} dBFS`);
}

// 32-bit float WAV (format 3) so the samples are saved exactly as received.
const header = Buffer.alloc(44);
header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8);
header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20);
header.writeUInt16LE(tap.channels, 22); header.writeUInt32LE(tap.sampleRate, 24);
header.writeUInt32LE(bytesPerSecond, 28); header.writeUInt16LE(tap.channels * 4, 32); header.writeUInt16LE(32, 34);
header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
writeFileSync("tap-test.wav", Buffer.concat([header, pcm]));
console.log("saved tap-test.wav");
