// End-to-end check of the filter wizard and profile code against a real OBS, using the app's own
// modules. It works only on a temporary scene and source that it creates and removes again, and
// refuses to run while OBS is streaming or recording.
//   npx tsx tools/verify-features.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FILTERS, addFilter, loadFilters, moveFilter, removeFilter, updateFilterSettings } from "../src/filters";
import { obs } from "../src/obs";
import { loadState } from "../src/obsAudio";
import { applyProfile, captureProfile } from "../src/profiles";

const SCENE = "obs-audio-kit 測試場景";
const INPUT = "obs-audio-kit 測試來源";
const APP_INPUT = "obs-audio-kit 測試應用程式";

const configPath =
  process.platform === "win32"
    ? join(process.env.APPDATA!, "obs-studio/plugin_config/obs-websocket/config.json")
    : join(homedir(), "Library/Application Support/obs-studio/plugin_config/obs-websocket/config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
await obs.connect(`ws://127.0.0.1:${config.server_port}`, config.auth_required ? config.server_password : undefined);

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

const [stream, record] = await Promise.all([obs.call("GetStreamStatus"), obs.call("GetRecordStatus")]);
if (stream.outputActive || record.outputActive) {
  console.log("OBS is streaming or recording; not running.");
  process.exit(1);
}
const programBefore = (await obs.call("GetCurrentProgramScene")).currentProgramSceneName;
const kinds = new Set((await obs.call("GetSourceFilterKindList")).sourceFilterKinds as string[]);
const inputKinds = new Set((await obs.call("GetInputKindList", { unversioned: true })).inputKinds as string[]);

// 1. The setting keys the wizard writes are the ones OBS uses.
for (const info of Object.values(FILTERS)) {
  if (!kinds.has(info.kind) || Object.keys(info.initial).length === 0) continue;
  const { defaultFilterSettings } = await obs.call("GetSourceFilterDefaultSettings", { filterKind: info.kind });
  const missing = Object.keys(info.initial).filter((k) => !(k in (defaultFilterSettings as object)));
  check(missing.length === 0, `${info.kind} setting keys match OBS`, missing.length ? `unknown: ${missing.join(",")}` : JSON.stringify(defaultFilterSettings));
}

await obs.call("CreateScene", { sceneName: SCENE });
try {
  await obs.call("CreateInput", { sceneName: SCENE, inputName: INPUT, inputKind: "ffmpeg_source", inputSettings: {}, sceneItemEnabled: true });

  // 2. App capture: what the "priority" values mean, so the wizard matches apps by executable.
  if (inputKinds.has("wasapi_process_output_capture")) {
    await obs.call("CreateInput", { sceneName: SCENE, inputName: APP_INPUT, inputKind: "wasapi_process_output_capture", inputSettings: {}, sceneItemEnabled: false });
    const { defaultInputSettings } = await obs.call("GetInputDefaultSettings", { inputKind: "wasapi_process_output_capture" });
    console.log(`info  app capture defaults: ${JSON.stringify(defaultInputSettings)}`);
    const { propertyItems } = await obs.call("GetInputPropertiesListPropertyItems", { inputName: APP_INPUT, propertyName: "priority" });
    console.log(`info  app capture priority items: ${JSON.stringify(propertyItems)}`);
    const exe = (propertyItems as { itemName: string; itemValue: number }[]).find((i) => i.itemValue === 2);
    check(exe !== undefined && /exe|執行檔|可執行/i.test(exe.itemName), "priority 2 means match by executable", exe?.itemName);
  }

  // 3. Filters land in the recommended order regardless of the order they are added in.
  for (const kind of ["limiter_filter", "compressor_filter", "noise_suppress_filter_v2", "noise_gate_filter"]) {
    if (kinds.has(kind)) await addFilter(INPUT, kind);
  }
  let chain = await loadFilters(INPUT);
  check(
    chain.map((f) => f.kind).join(",") === "noise_suppress_filter_v2,noise_gate_filter,compressor_filter,limiter_filter",
    "wizard keeps the recommended chain order",
    chain.map((f) => f.name).join(" → "),
  );
  const gate = chain.find((f) => f.kind === "noise_gate_filter")!;
  check(gate.settings.open_threshold === -26 && gate.settings.close_threshold === -32, "noise gate starts at -26/-32 dB");
  const compressor = chain.find((f) => f.kind === "compressor_filter")!;
  check(compressor.settings.ratio === 4 && compressor.settings.threshold === -18, "compressor starts at 4:1, -18 dB");

  // 4. Settings, moving and removing.
  await updateFilterSettings(INPUT, gate.name, { open_threshold: -30 });
  chain = await loadFilters(INPUT);
  check(chain.find((f) => f.name === gate.name)?.settings.open_threshold === -30, "slider change reaches OBS");
  check(chain.find((f) => f.name === gate.name)?.settings.close_threshold === -32, "other settings untouched by overlay");
  await moveFilter(INPUT, gate.name, 0);
  chain = await loadFilters(INPUT);
  check(chain[0].name === gate.name, "filter moves up");
  const added2 = await addFilter(INPUT, "gain_filter");
  check(added2 === "增益", "new filter gets its plain name", added2);
  const dup = await addFilter(INPUT, "gain_filter");
  check(dup === "增益 2", "second filter of a kind gets a unique name", dup);
  await removeFilter(INPUT, dup);
  check(!(await loadFilters(INPUT)).some((f) => f.name === dup), "filter removed");

  // 5. Profiles: capture, change things, apply, and everything comes back.
  await obs.call("SetInputVolume", { inputName: INPUT, inputVolumeDb: -10 });
  await obs.call("SetInputMute", { inputName: INPUT, inputMuted: true });
  await obs.call("SetInputAudioBalance", { inputName: INPUT, inputAudioBalance: 0.3 });
  await obs.call("SetInputAudioSyncOffset", { inputName: INPUT, inputAudioSyncOffset: 50 });
  await obs.call("SetInputAudioMonitorType", { inputName: INPUT, monitorType: "OBS_MONITORING_TYPE_MONITOR_ONLY" });
  await obs.call("SetInputAudioTracks", { inputName: INPUT, inputAudioTracks: { "1": true, "2": true, "3": false, "4": false, "5": false, "6": false } });
  const state = await loadState();
  const source = state.sources.find((s) => s.name === INPUT);
  check(source !== undefined, "test source shows up in the app state");
  const profile = await captureProfile("verify", state.sources.filter((s) => s.name === INPUT));
  const savedChain = profile.sources[0].filters.map((f) => f.name);

  await obs.call("SetInputVolume", { inputName: INPUT, inputVolumeDb: 0 });
  await obs.call("SetInputMute", { inputName: INPUT, inputMuted: false });
  await obs.call("SetInputAudioBalance", { inputName: INPUT, inputAudioBalance: 0.5 });
  await obs.call("SetInputAudioSyncOffset", { inputName: INPUT, inputAudioSyncOffset: 0 });
  await obs.call("SetInputAudioMonitorType", { inputName: INPUT, monitorType: "OBS_MONITORING_TYPE_NONE" });
  await obs.call("SetInputAudioTracks", { inputName: INPUT, inputAudioTracks: { "2": false, "5": true } });
  await removeFilter(INPUT, compressor.name);
  await updateFilterSettings(INPUT, gate.name, { open_threshold: -10 });
  await addFilter(INPUT, "expander_filter");

  const after = (await loadState()).sources.filter((s) => s.name === INPUT);
  const result = await applyProfile({ ...profile, sources: [...profile.sources, { ...profile.sources[0], name: "不存在的來源" }] }, after);
  check(result.applied.join() === INPUT && result.missing.join() === "不存在的來源", "apply reports applied and missing sources", JSON.stringify(result));
  check(result.extraFilters.some((f) => f.includes("擴展器")), "filter not in the profile is reported, not removed");

  const restored = (await loadState()).sources.find((s) => s.name === INPUT)!;
  // OBS keeps balance as a float, so 0.3 comes back as 0.30000001.
  check(
    restored.volumeDb === -10 && restored.muted && Math.abs(restored.balance - 0.3) < 1e-4 && restored.syncOffsetMs === 50,
    "volume, mute, balance, sync restored",
    JSON.stringify(restored),
  );
  check(restored.monitorType === "OBS_MONITORING_TYPE_MONITOR_ONLY", "monitor type restored");
  check(restored.tracks.join() === "1,2", "tracks restored", restored.tracks.join());
  const restoredChain = await loadFilters(INPUT);
  check(
    savedChain.every((n, i) => restoredChain[i]?.name === n),
    "filter chain restored in saved order (deleted one recreated)",
    restoredChain.map((f) => f.name).join(" → "),
  );
  check(restoredChain.find((f) => f.name === gate.name)?.settings.open_threshold === -30, "filter settings restored");
} finally {
  await obs.call("RemoveInput", { inputName: INPUT }).catch(() => {});
  await obs.call("RemoveInput", { inputName: APP_INPUT }).catch(() => {});
  await obs.call("RemoveScene", { sceneName: SCENE }).catch(() => {});
  // OBS removes the scene asynchronously; give it a moment before checking.
  let leftovers = true;
  for (let i = 0; i < 20 && leftovers; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const scenes = (await obs.call("GetSceneList")).scenes.map((s) => s.sceneName);
    const inputs = (await obs.call("GetInputList")).inputs.map((i) => i.inputName);
    leftovers = scenes.includes(SCENE) || inputs.includes(INPUT) || inputs.includes(APP_INPUT);
  }
  check(!leftovers, "temporary scene and source removed");
  check((await obs.call("GetCurrentProgramScene")).currentProgramSceneName === programBefore, "program scene unchanged");
  await obs.disconnect();
}

console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
