// End-to-end check of the Streamlabs adapter, filter wizard and profiles against a real
// Streamlabs Desktop, using the app's own modules. It works only on a temporary source that is
// in no scene, removes it again, and refuses to run while Streamlabs is streaming or recording.
//   npx tsx tools/verify-streamlabs.ts
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Changes } from "../src/adapter";
import { addFilter } from "../src/filters";
import { t } from "../src/i18n";
import { applyProfile, captureProfile } from "../src/profiles";
import { streamlabs } from "../src/streamlabs";
import { streamlabsAdapter as sl } from "../src/streamlabsAdapter";

const INPUT = "SoundCheck 測試來源";
const path = process.platform === "win32" ? "\\\\.\\pipe\\slobs" : join(homedir(), "Library/Application Support/slobs-client/slobs.sock");

streamlabs.useTransport((onLine, onClosed) => {
  let socket: net.Socket | null = null;
  return {
    connect: () =>
      new Promise<void>((resolve, reject) => {
        let buffer = "";
        socket = net.connect(path, () => resolve());
        socket.on("error", reject);
        socket.on("close", onClosed);
        socket.on("data", (chunk) => {
          buffer += chunk.toString();
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            onLine(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
          }
        });
      }),
    disconnect: () => socket?.end(),
    send: async (line) => void socket?.write(line + "\n"),
  };
});

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const source = async () => (await sl.load()).sources.find((s) => s.name === INPUT);

await streamlabs.connect();
const outputs = await streamlabs.request<{ status: Record<string, { streaming: string; recording: string }> }>("StreamingService", "getModel");
if (Object.values(outputs.status).some((s) => s.streaming !== "offline" || s.recording !== "offline")) {
  console.log("Streamlabs is streaming or recording; not running.");
  process.exit(1);
}
const before = await sl.load();
if (before.sources.some((s) => s.name === INPUT)) {
  console.log(`"${INPUT}" already exists (left over from an earlier run?); remove it first.`);
  process.exit(1);
}

// Count what the adapter reports while we change things.
const seen = { reload: 0, patch: [] as string[] };
const changes: Changes = {
  reload: () => seen.reload++,
  patchSource: (name, patch) => name === INPUT && seen.patch.push(Object.keys(typeof patch === "function" ? {} : patch).join(",")),
  patchItem: () => {},
  programScene: () => {},
  levels: () => {},
};
const stopWatching = sl.watch(changes);
const filters = sl.filters!;

await sl.createSource(INPUT, "ffmpeg_source", {}, []);
try {
  await wait(300);
  const created = await source();
  check(created !== undefined, "temporary source shows up in the app state");
  check((await sceneCount()) === before.scenes.length, "no scene was added");

  // 1. Audio settings, and the events that report them.
  seen.patch = [];
  await sl.setMonitorType!(INPUT, "monitorOnly");
  await sl.setTracks!(INPUT, [1, 3]);
  await sl.setSyncOffset!(INPUT, 120);
  await wait(300);
  let s = await source();
  check(s?.monitorType === "monitorOnly", "monitoring set", s?.monitorType);
  check(s?.tracks.join() === "1,3", "tracks set", s?.tracks.join());
  check(s?.syncOffsetMs === 120, "sync offset set", String(s?.syncOffsetMs));
  check(seen.patch.length >= 3, "audioSourceUpdated reports each change", String(seen.patch.length));
  seen.patch = [];
  seen.reload = 0;
  await sl.setMuted(INPUT, true);
  await wait(500);
  check(seen.patch.includes("muted"), "a mute is reported directly", seen.patch.join(" | "));
  check(seen.reload === 0, "a mute doesn't reload everything", `reloads ${seen.reload}`);
  await sl.setVolume(INPUT, -12);
  await wait(300);
  s = await source();
  check(s?.muted === true && Math.abs((s?.volumeDb ?? 0) + 12) < 0.5, "volume and mute set", `${s?.volumeDb} dB, muted ${s?.muted}`);

  // 2. Filters land in the recommended order, with the wizard's starting settings.
  let filterChanges = 0;
  const stopFilters = filters.watch(INPUT, () => filterChanges++);
  for (const kind of ["limiter_filter", "compressor_filter", "noise_suppress_filter_v2", "noise_gate_filter"]) {
    await addFilter(filters, INPUT, kind).catch((e) => check(false, `add ${kind}`, e.message));
  }
  await wait(300);
  check(filterChanges > 0, "filter changes are reported to the wizard", String(filterChanges));
  stopFilters();
  let chain = await filters.list(INPUT);
  check(
    chain.map((f) => f.kind).join(",") === "noise_suppress_filter_v2,noise_gate_filter,compressor_filter,limiter_filter",
    "wizard keeps the recommended chain order",
    chain.map((f) => f.name).join(" → "),
  );
  const gate = chain.find((f) => f.kind === "noise_gate_filter")!;
  check(gate.settings.open_threshold === -26 && gate.settings.close_threshold === -32, "noise gate starts at -26/-32 dB", JSON.stringify(gate.settings));
  check(Object.keys(gate.settings).length > 2, "filter settings include the defaults", Object.keys(gate.settings).join(","));
  const compressor = chain.find((f) => f.kind === "compressor_filter")!;

  // 3. Settings (merged, not replaced), enabling, moving, removing.
  await filters.setSettings(INPUT, gate.name, { open_threshold: -30 });
  chain = await filters.list(INPUT);
  const g = chain.find((f) => f.name === gate.name);
  check(g?.settings.open_threshold === -30, "slider change reaches Streamlabs");
  check(g?.settings.close_threshold === -32, "other settings kept");
  const stored = await streamlabs.request<{ name: string; settings: Record<string, unknown> }[]>("SourceFiltersService", "getFilters", (await streamlabs.request<any[]>("AudioService", "getSources")).find((a) => a.name === INPUT).sourceId);
  check(stored.find((f) => f.name === gate.name)?.settings.close_threshold === -32, "Streamlabs' own copy keeps the other settings too");
  await filters.setEnabled(INPUT, compressor.name, false);
  check((await filters.list(INPUT)).find((f) => f.name === compressor.name)?.enabled === false, "filter disabled");
  await filters.setEnabled(INPUT, compressor.name, true);
  await filters.move(INPUT, gate.name, 0);
  chain = await filters.list(INPUT);
  check(chain[0].name === gate.name, "filter moves up", chain.map((f) => f.name).join(" → "));
  const dup = await addFilter(filters, INPUT, "gain_filter");
  const dup2 = await addFilter(filters, INPUT, "gain_filter");
  check(dup === t("增益") && dup2 === `${t("增益")} 2`, "names are unique", `${dup}, ${dup2}`);
  await filters.remove(INPUT, dup2);
  check(!(await filters.list(INPUT)).some((f) => f.name === dup2), "filter removed");

  // 4. Profiles: capture, change things, apply, and everything comes back.
  const profile = await captureProfile(sl, "verify", (await sl.load()).sources.filter((x) => x.name === INPUT));
  check(typeof profile.sceneCollection === "string" && profile.sceneCollection.length > 0, "profile records the scene collection", profile.sceneCollection);
  const savedChain = profile.sources[0].filters.map((f) => f.name);
  await sl.setMonitorType!(INPUT, "off");
  await sl.setTracks!(INPUT, [2]);
  await sl.setSyncOffset!(INPUT, 0);
  await sl.setMuted(INPUT, false);
  await sl.setVolume(INPUT, 0);
  await filters.remove(INPUT, compressor.name);
  await filters.setSettings(INPUT, gate.name, { open_threshold: -10 });
  await addFilter(filters, INPUT, "expander_filter");
  await wait(300);
  const result = await applyProfile(sl, profile, (await sl.load()).sources.filter((x) => x.name === INPUT));
  check(result.applied.join() === INPUT && result.errors.length === 0, "profile applied", JSON.stringify(result));
  check(result.removedFilters.some((f) => f.includes(t("擴展器"))), "filter not in the profile is removed and reported");
  await wait(300);
  s = await source();
  check(s?.monitorType === "monitorOnly" && s?.tracks.join() === "1,3" && s?.syncOffsetMs === 120, "monitoring, tracks, sync restored", JSON.stringify(s));
  check(s?.muted === true && Math.abs((s?.volumeDb ?? 0) + 12) < 0.5, "volume and mute restored", `${s?.volumeDb} dB`);
  const restored = await filters.list(INPUT);
  check(restored.map((f) => f.name).join() === savedChain.join(), "filter chain restored exactly (extra one removed)", restored.map((f) => f.name).join(" → "));
  check(restored.find((f) => f.name === gate.name)?.settings.open_threshold === -30, "filter settings restored");
} finally {
  stopWatching();
  const id = (await streamlabs.request<{ name: string; sourceId: string }[]>("SourcesService", "getSources")).find((x) => x.name === INPUT)?.sourceId;
  if (id) await streamlabs.request("SourcesService", "removeSource", id);
  await wait(500);
  check(!(await sl.load()).sources.some((x) => x.name === INPUT), "temporary source removed");
  check((await sl.load()).programScene === before.programScene, "program scene unchanged");
  streamlabs.disconnect();
}

async function sceneCount() {
  return (await sl.load()).scenes.length;
}

console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
