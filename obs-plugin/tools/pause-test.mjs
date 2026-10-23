// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 weisunglee

// Checks the plugin's stream-audio pause and its heartbeat watchdog:
//   node pause-test.mjs
// The stream tracks go silent for about 8 seconds in total, so it refuses to
// run while OBS is streaming.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import OBSWebSocket from "obs-websocket-js";

const config = JSON.parse(readFileSync(join(process.env.APPDATA, "obs-studio/plugin_config/obs-websocket/config.json"), "utf8"));
const obs = new OBSWebSocket();
await obs.connect(`ws://127.0.0.1:${config.server_port}`, config.auth_required ? config.server_password : undefined);

const vendor = (requestType, requestData = {}) =>
  obs.call("CallVendorRequest", { vendorName: "soundcheck", requestType, requestData }).then((r) => r.responseData);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if ((await obs.call("GetStreamStatus")).outputActive) {
  console.log("OBS is streaming; not running the pause test.");
  process.exit(1);
}

const info = await vendor("GetInfo");
const streamTracks = info.streamTracks.map((t) => String(t.track));
console.log(`stream tracks: ${streamTracks.join(",")} (${info.streamTracksOrigin})`);

async function snapshot() {
  const tracks = new Map();
  for (const { inputName } of (await obs.call("GetInputList")).inputs) {
    try {
      tracks.set(inputName, (await obs.call("GetInputAudioTracks", { inputName })).inputAudioTracks);
    } catch {
      // video-only input
    }
  }
  return tracks;
}

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
const sameAs = (a, b) => [...a].every(([name, t]) => JSON.stringify(t) === JSON.stringify(b.get(name)));
const noneOnStream = (snap) => [...snap.values()].every((t) => streamTracks.every((k) => !t[k]));

const original = await snapshot();
const onStream = [...original.values()].filter((t) => streamTracks.some((k) => t[k])).length;
console.log(`${original.size} audio inputs, ${onStream} of them on a stream track`);

try {
  // 1. Pause takes every source off the stream tracks and keeps the other tracks.
  check((await vendor("PauseStreamAudio", { timeoutMs: 2000 })).ok, "PauseStreamAudio succeeds");
  const paused = await snapshot();
  check(noneOnStream(paused), "no input is on a stream track while paused");
  check(
    [...paused].every(([name, t]) => Object.keys(t).every((k) => streamTracks.includes(k) || t[k] === original.get(name)[k])),
    "non-stream tracks are untouched",
  );
  check((await vendor("PauseStreamAudio", { timeoutMs: 2000 })).ok === false, "a second pause is refused");

  // 2. Heartbeats keep it paused past the timeout.
  for (let i = 0; i < 3; i++) {
    await sleep(1000);
    await vendor("Heartbeat");
  }
  check(noneOnStream(await snapshot()), "still paused after 3 s of heartbeats (timeout 2 s)");

  // 3. Without heartbeats the watchdog restores everything.
  await sleep(3000);
  check(sameAs(original, await snapshot()), "watchdog restored all tracks after heartbeats stopped");
  check((await vendor("GetInfo")).streamAudioPaused === false, "GetInfo reports not paused");

  // 4. An explicit resume restores immediately.
  await vendor("PauseStreamAudio", { timeoutMs: 5000 });
  await vendor("ResumeStreamAudio");
  check(sameAs(original, await snapshot()), "ResumeStreamAudio restored all tracks");
} finally {
  await vendor("ResumeStreamAudio").catch(() => {});
  if (!sameAs(original, await snapshot())) {
    console.log("WARNING: tracks differ from the start of the test; restoring them directly");
    for (const [inputName, inputAudioTracks] of original) await obs.call("SetInputAudioTracks", { inputName, inputAudioTracks });
  }
  await obs.disconnect();
}

console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
