// OBS Studio behind the SoftwareAdapter interface, over obs-websocket v5. OBS can do everything
// the interface offers, and reports every change as an event.
import type { RequestBatchRequest } from "obs-websocket-js";
import { AUDIO_FILTER_KINDS, type AudioState, type CaptureSettings, type FilterOps, INPUT_KIND_LABELS, type SoftwareAdapter } from "./adapter";
import { meterPosition, toDb } from "./levels";
import { obs } from "./obsClient";
import { plugin } from "./plugin";
import { CAPTURE_KIND_SET } from "./systemAudio";
import type { AudioSource, ChannelLevels, Filter, MonitorType, Scene, SceneItem } from "./types";

const STRUCTURE_EVENTS = [
  "SceneCreated",
  "SceneRemoved",
  "SceneNameChanged",
  "SceneListChanged",
  "SceneItemCreated",
  "SceneItemRemoved",
  "InputCreated",
  "InputRemoved",
  "InputNameChanged",
  "SourceFilterCreated",
  "SourceFilterRemoved",
  "SourceFilterNameChanged",
  "SourceFilterListReindexed",
  "CurrentSceneCollectionChanged",
] as const;

const FILTER_EVENTS = [
  "SourceFilterCreated",
  "SourceFilterRemoved",
  "SourceFilterNameChanged",
  "SourceFilterListReindexed",
  "SourceFilterEnableStateChanged",
] as const;

const OBS_MONITOR_TYPES: Record<MonitorType, string> = {
  off: "OBS_MONITORING_TYPE_NONE",
  monitorOnly: "OBS_MONITORING_TYPE_MONITOR_ONLY",
  monitorAndOutput: "OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT",
};

const fromObsMonitorType = (value: string): MonitorType =>
  (Object.keys(OBS_MONITOR_TYPES) as MonitorType[]).find((k) => OBS_MONITOR_TYPES[k] === value) ?? "off";

const ALL_TRACKS = [1, 2, 3, 4, 5, 6];

const tracksFrom = (map: Record<string, boolean>) =>
  Object.entries(map)
    .filter(([, on]) => on)
    .map(([t]) => Number(t));

type BatchResult = { ok: boolean; data: Record<string, any> };

async function batch(requests: RequestBatchRequest[]): Promise<BatchResult[]> {
  if (requests.length === 0) return [];
  const results = await obs.callBatch(requests, { haltOnFailure: false });
  return results.map((r) => ({ ok: r.requestStatus.result, data: (r.responseData ?? {}) as Record<string, any> }));
}

type SceneItemData = { sceneItemId: number; sourceName: string; sceneItemEnabled: boolean; isGroup: boolean | null; sourceType: string };

const toItems = (items: SceneItemData[]): SceneItem[] =>
  items.map((i) => ({
    id: i.sceneItemId,
    sourceName: i.sourceName,
    enabled: i.sceneItemEnabled,
    isScene: i.sourceType === "OBS_SOURCE_TYPE_SCENE" || Boolean(i.isGroup),
  }));

async function load(): Promise<AudioState> {
  const [sceneList, inputList, special] = await Promise.all([
    obs.call("GetSceneList"),
    obs.call("GetInputList"),
    obs.call("GetSpecialInputs"),
  ]);

  const sceneOrder = (sceneList.scenes as { sceneName: string; sceneIndex: number }[])
    .sort((a, b) => b.sceneIndex - a.sceneIndex)
    .map((s) => s.sceneName);

  const sceneItems = await batch(sceneOrder.map((sceneName) => ({ requestType: "GetSceneItemList", requestData: { sceneName } })));
  const scenes: Scene[] = sceneOrder.map((name, i) => ({
    name,
    items: toItems((sceneItems[i].data.sceneItems ?? []) as SceneItemData[]),
  }));

  const groupNames = [
    ...new Set(
      sceneItems.flatMap((r) => ((r.data.sceneItems ?? []) as SceneItemData[]).filter((i) => i.isGroup).map((i) => i.sourceName)),
    ),
  ];
  const groupItems = await batch(groupNames.map((sceneName) => ({ requestType: "GetGroupSceneItemList", requestData: { sceneName } })));
  groupNames.forEach((name, i) =>
    scenes.push({ name, isGroup: true, items: toItems((groupItems[i].data.sceneItems ?? []) as SceneItemData[]) }),
  );

  const globalNames = new Set(Object.values(special).filter((v): v is string => typeof v === "string"));
  const inputs = inputList.inputs as { inputName: string; inputKind: string; unversionedInputKind: string }[];
  const PER_INPUT = [
    "GetInputAudioTracks",
    "GetInputVolume",
    "GetInputMute",
    "GetInputAudioMonitorType",
    "GetSourceFilterList",
    "GetInputAudioBalance",
    "GetInputAudioSyncOffset",
  ];
  const perInput = await batch(
    inputs.flatMap(({ inputName }) =>
      PER_INPUT.map((requestType) => ({
        requestType,
        requestData: requestType === "GetSourceFilterList" ? { sourceName: inputName } : { inputName },
      })) as RequestBatchRequest[],
    ),
  );

  const sources: AudioSource[] = [];
  inputs.forEach((input, i) => {
    const [tracks, volume, mute, monitor, filters, balance, sync] = perInput.slice(i * PER_INPUT.length, (i + 1) * PER_INPUT.length);
    // Video-only inputs (images, colour sources…) reject the audio requests.
    if (!tracks.ok || !volume.ok) return;
    sources.push({
      name: input.inputName,
      device: INPUT_KIND_LABELS[input.unversionedInputKind] ?? input.unversionedInputKind,
      inputKind: input.unversionedInputKind,
      volumeDb: volume.data.inputVolumeDb as number,
      muted: mute.data.inputMuted as boolean,
      balance: (balance.data.inputAudioBalance as number | undefined) ?? 0.5,
      syncOffsetMs: (sync.data.inputAudioSyncOffset as number | undefined) ?? 0,
      monitorType: fromObsMonitorType(monitor.data.monitorType as string),
      filters: ((filters.data.filters ?? []) as { filterName: string; filterKind: string; filterEnabled: boolean }[])
        .filter((f) => AUDIO_FILTER_KINDS.has(f.filterKind))
        .map((f): Filter => ({ name: f.filterName, kind: f.filterKind, enabled: f.filterEnabled })),
      tracks: tracksFrom(tracks.data.inputAudioTracks as Record<string, boolean>),
      global: globalNames.has(input.inputName),
    });
  });

  // Only the SoundCheck plugin can tell which tracks the stream encodes; without it, assume
  // OBS's default of track 1.
  const streamTracks = await plugin.info().then(
    (info) => info.streamTracks,
    () => [1],
  );

  return { sources, scenes, sceneOrder, programScene: sceneList.currentProgramSceneName as string, streamTracks };
}

const filters: FilterOps = {
  async list(sourceName) {
    const { filters } = await obs.call("GetSourceFilterList", { sourceName });
    const list = filters as { filterName: string; filterKind: string; filterEnabled: boolean; filterIndex: number; filterSettings: Record<string, any> }[];
    const kinds = [...new Set(list.map((f) => f.filterKind))];
    const defaults = new Map<string, Record<string, any>>();
    await Promise.all(
      kinds.map((filterKind) =>
        obs
          .call("GetSourceFilterDefaultSettings", { filterKind })
          .then((r) => defaults.set(filterKind, r.defaultFilterSettings as Record<string, any>))
          .catch(() => defaults.set(filterKind, {})),
      ),
    );
    return list
      .map((f) => ({
        name: f.filterName,
        kind: f.filterKind,
        enabled: f.filterEnabled,
        index: f.filterIndex,
        settings: { ...defaults.get(f.filterKind), ...f.filterSettings },
      }))
      .sort((a, b) => a.index - b.index);
  },
  async create(sourceName, filterName, filterKind, filterSettings) {
    await obs.call("CreateSourceFilter", { sourceName, filterName, filterKind, filterSettings });
  },
  async remove(sourceName, filterName) {
    await obs.call("RemoveSourceFilter", { sourceName, filterName });
  },
  async rename(sourceName, filterName, newFilterName) {
    await obs.call("SetSourceFilterName", { sourceName, filterName, newFilterName });
  },
  async move(sourceName, filterName, filterIndex) {
    await obs.call("SetSourceFilterIndex", { sourceName, filterName, filterIndex });
  },
  async setSettings(sourceName, filterName, filterSettings, replace = false) {
    await obs.call("SetSourceFilterSettings", { sourceName, filterName, filterSettings, overlay: !replace });
  },
  async setEnabled(sourceName, filterName, filterEnabled) {
    await obs.call("SetSourceFilterEnabled", { sourceName, filterName, filterEnabled });
  },
  watch(sourceName, onChange) {
    const handler = (e: { sourceName?: string }) => e.sourceName === sourceName && onChange();
    for (const name of FILTER_EVENTS) obs.on(name, handler);
    return () => {
      for (const name of FILTER_EVENTS) obs.off(name, handler);
    };
  },
};

export const obsAdapter: SoftwareAdapter = {
  id: "obs",
  meters: true,
  load,

  watch(changes) {
    const handlers: [string, (e: any) => void][] = [
      ["InputVolumeChanged", (e) => changes.patchSource(e.inputName, { volumeDb: e.inputVolumeDb })],
      ["InputMuteStateChanged", (e) => changes.patchSource(e.inputName, { muted: e.inputMuted })],
      ["InputAudioMonitorTypeChanged", (e) => changes.patchSource(e.inputName, { monitorType: fromObsMonitorType(e.monitorType) })],
      ["InputAudioBalanceChanged", (e) => changes.patchSource(e.inputName, { balance: e.inputAudioBalance })],
      ["InputAudioSyncOffsetChanged", (e) => changes.patchSource(e.inputName, { syncOffsetMs: e.inputAudioSyncOffset })],
      ["InputAudioTracksChanged", (e) => changes.patchSource(e.inputName, { tracks: tracksFrom(e.inputAudioTracks) })],
      [
        "SourceFilterEnableStateChanged",
        (e) =>
          changes.patchSource(e.sourceName, (s) => ({
            filters: s.filters.map((f) => (f.name === e.filterName ? { ...f, enabled: e.filterEnabled } : f)),
          })),
      ],
      ["CurrentProgramSceneChanged", (e) => changes.programScene(e.sceneName)],
      ["SceneItemEnableStateChanged", (e) => changes.patchItem(e.sceneName, e.sceneItemId, e.sceneItemEnabled)],
      [
        "InputVolumeMeters",
        (e) => {
          const levels: Record<string, ChannelLevels> = {};
          const inputDb: Record<string, number> = {};
          for (const input of e.inputs as { inputName: string; inputLevelsMul: number[][] }[]) {
            // inputLevelsMul is [channel][magnitude, peak, inputPeak]; meters use the post-fader peak.
            const [l, r] = input.inputLevelsMul;
            const left = meterPosition(l?.[1] ?? 0);
            levels[input.inputName] = [left, r ? meterPosition(r[1]) : left];
            const rawPeak = toDb(Math.max(0, ...input.inputLevelsMul.map((ch) => ch[2] ?? 0)));
            if (rawPeak !== null) inputDb[input.inputName] = rawPeak;
          }
          changes.levels(levels, inputDb);
        },
      ],
      ...STRUCTURE_EVENTS.map((name): [string, () => void] => [name, changes.reload]),
    ];
    for (const [name, handler] of handlers) obs.on(name as any, handler);
    return () => {
      for (const [name, handler] of handlers) obs.off(name as any, handler);
    };
  },

  async setVolume(inputName, inputVolumeDb) {
    await obs.call("SetInputVolume", { inputName, inputVolumeDb });
  },
  async setMuted(inputName, inputMuted) {
    await obs.call("SetInputMute", { inputName, inputMuted });
  },
  async switchScene(sceneName) {
    await obs.call("SetCurrentProgramScene", { sceneName });
  },
  async setItemVisible(sceneName, item, sceneItemEnabled) {
    await obs.call("SetSceneItemEnabled", { sceneName, sceneItemId: Number(item.id), sceneItemEnabled });
  },
  listInputKinds: async () => new Set((await obs.call("GetInputKindList", { unversioned: true })).inputKinds as string[]),
  async createSource(inputName, inputKind, inputSettings, scenes) {
    await obs.call("CreateInput", { sceneName: scenes[0], inputName, inputKind, inputSettings, sceneItemEnabled: true });
    for (const sceneName of scenes.slice(1)) {
      await obs.call("CreateSceneItem", { sceneName, sourceName: inputName, sceneItemEnabled: true });
    }
  },
  async captureSettings(sources) {
    const result: CaptureSettings = new Map();
    await Promise.all(
      sources
        .filter((s) => CAPTURE_KIND_SET.has(s.inputKind))
        .map((s) =>
          obs
            .call("GetInputSettings", { inputName: s.name })
            .then((r) => result.set(s.name, { kind: s.inputKind, settings: r.inputSettings as Record<string, any> }))
            .catch(() => {}),
        ),
    );
    return result;
  },

  async setMonitorType(inputName, type) {
    await obs.call("SetInputAudioMonitorType", { inputName, monitorType: OBS_MONITOR_TYPES[type] });
  },
  async setTracks(inputName, tracks) {
    const inputAudioTracks = Object.fromEntries(ALL_TRACKS.map((t) => [String(t), tracks.includes(t)]));
    await obs.call("SetInputAudioTracks", { inputName, inputAudioTracks });
  },
  async setBalance(inputName, inputAudioBalance) {
    await obs.call("SetInputAudioBalance", { inputName, inputAudioBalance });
  },
  async setSyncOffset(inputName, inputAudioSyncOffset) {
    await obs.call("SetInputAudioSyncOffset", { inputName, inputAudioSyncOffset });
  },
  syncOffsetRange: [-950, 20000],
  filters,
  sceneCollection: async () => (await obs.call("GetSceneCollectionList")).currentSceneCollectionName,
};

/** Whether OBS is streaming or recording right now (for warnings before it has to close). */
export async function outputsActive(): Promise<{ streaming: boolean; recording: boolean }> {
  const [stream, record] = await Promise.all([obs.call("GetStreamStatus"), obs.call("GetRecordStatus")]);
  return { streaming: stream.outputActive, recording: record.outputActive };
}
