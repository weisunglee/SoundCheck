// Live audio-related OBS state: audio sources, scenes, and meters, kept in sync through events.
import type { RequestBatchRequest } from "obs-websocket-js";
import { useCallback, useEffect, useRef, useState } from "react";
import { obs, pluginRequest } from "./obs";
import type { AudioSource, ChannelLevels, Filter, MonitorType, Scene, SceneItem } from "./types";

export interface ObsAudioState {
  sources: AudioSource[];
  scenes: Scene[];
  /** Switchable scenes in the order OBS shows them (groups excluded). */
  sceneOrder: string[];
  programScene: string;
  streamTracks: number[];
  /** False when the obs-audio-kit plugin isn't loaded; stream tracks then fall back to track 1. */
  pluginAvailable: boolean;
}

/** Names users see for OBS input kinds, per platform. */
const INPUT_KIND_LABELS: Record<string, string> = {
  wasapi_input_capture: "音訊輸入擷取",
  wasapi_output_capture: "音訊輸出擷取",
  wasapi_process_output_capture: "應用程式音訊擷取",
  coreaudio_input_capture: "音訊輸入擷取",
  coreaudio_output_capture: "音訊輸出擷取",
  sck_audio_capture: "macOS 音訊擷取",
  pulse_input_capture: "音訊輸入擷取",
  pulse_output_capture: "音訊輸出擷取",
  ffmpeg_source: "媒體來源",
  vlc_source: "VLC 影片來源",
  browser_source: "瀏覽器來源",
  dshow_input: "視訊擷取裝置",
  av_capture_input: "視訊擷取裝置",
  game_capture: "遊戲擷取",
  window_capture: "視窗擷取",
  screen_capture: "螢幕擷取",
  ndi_source: "NDI 來源",
};

/** Filter kinds that process audio; other filters on a source (chroma key, crop…) are left out. */
const AUDIO_FILTER_KINDS = new Set([
  "noise_suppress_filter",
  "noise_suppress_filter_v2",
  "noise_gate_filter",
  "compressor_filter",
  "limiter_filter",
  "gain_filter",
  "expander_filter",
  "upward_compressor_filter",
  "basic_eq_filter",
  "invert_polarity_filter",
  "vst_filter",
]);

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
  "CurrentSceneCollectionChanged",
] as const;

const RELOAD_DEBOUNCE_MS = 300;

/** Maps a 0..1 amplitude to the meter's -60..0 dB scale. */
function meterPosition(amplitude: number): number {
  if (amplitude <= 0) return 0;
  return Math.min(1, Math.max(0, (20 * Math.log10(amplitude) + 60) / 60));
}

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

export async function loadState(): Promise<ObsAudioState> {
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
  const PER_INPUT = ["GetInputAudioTracks", "GetInputVolume", "GetInputMute", "GetInputAudioMonitorType", "GetSourceFilterList"];
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
    const [tracks, volume, mute, monitor, filters] = perInput.slice(i * PER_INPUT.length, (i + 1) * PER_INPUT.length);
    // Video-only inputs (images, colour sources…) reject the audio requests.
    if (!tracks.ok || !volume.ok) return;
    const trackMap = tracks.data.inputAudioTracks as Record<string, boolean>;
    sources.push({
      name: input.inputName,
      device: INPUT_KIND_LABELS[input.unversionedInputKind] ?? input.unversionedInputKind,
      volumeDb: volume.data.inputVolumeDb as number,
      muted: mute.data.inputMuted as boolean,
      monitorType: monitor.data.monitorType as MonitorType,
      filters: ((filters.data.filters ?? []) as { filterName: string; filterKind: string; filterEnabled: boolean }[])
        .filter((f) => AUDIO_FILTER_KINDS.has(f.filterKind))
        .map((f): Filter => ({ name: f.filterName, kind: f.filterKind, enabled: f.filterEnabled })),
      tracks: Object.entries(trackMap)
        .filter(([, on]) => on)
        .map(([t]) => Number(t)),
      global: globalNames.has(input.inputName),
    });
  });

  let streamTracks = [1];
  let pluginAvailable = false;
  try {
    const info = await pluginRequest<{ streamTracks: { track: number }[] }>("GetInfo");
    streamTracks = info.streamTracks.map((t) => t.track);
    pluginAvailable = true;
  } catch {
    // Without the plugin, assume the usual default of track 1.
  }

  return { sources, scenes, sceneOrder, programScene: sceneList.currentProgramSceneName as string, streamTracks, pluginAvailable };
}

export interface ObsAudio {
  state: ObsAudioState | null;
  levels: Record<string, ChannelLevels>;
  error: string | null;
  setVolume: (name: string, db: number) => void;
  setMuted: (name: string, muted: boolean) => void;
  setMonitorType: (name: string, type: MonitorType) => void;
  setFilterEnabled: (source: string, filter: string, enabled: boolean) => void;
  addStreamTracks: (name: string) => void;
  showInProgram: (items: { sceneName: string; item: SceneItem }[]) => void;
  switchScene: (scene: string) => void;
}

/** Loads the audio state once connected and keeps it live; every setter writes to OBS. */
export function useObsAudio(connected: boolean): ObsAudio {
  const [state, setState] = useState<ObsAudioState | null>(null);
  const [levels, setLevels] = useState<Record<string, ChannelLevels>>({});
  const [error, setError] = useState<string | null>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const reload = useCallback(() => {
    clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => {
      loadState()
        .then((s) => (setState(s), setError(null)))
        .catch((e: Error) => setError(`讀取 OBS 狀態失敗：${e.message}`));
    }, RELOAD_DEBOUNCE_MS);
  }, []);

  const patchSource = useCallback((name: string, patch: (s: AudioSource) => AudioSource) => {
    setState((prev) => prev && { ...prev, sources: prev.sources.map((s) => (s.name === name ? patch(s) : s)) });
  }, []);

  useEffect(() => {
    if (!connected) {
      setState(null);
      return;
    }
    reload();

    const handlers: [string, (e: any) => void][] = [
      ["InputVolumeChanged", (e) => patchSource(e.inputName, (s) => ({ ...s, volumeDb: e.inputVolumeDb }))],
      ["InputMuteStateChanged", (e) => patchSource(e.inputName, (s) => ({ ...s, muted: e.inputMuted }))],
      ["InputAudioMonitorTypeChanged", (e) => patchSource(e.inputName, (s) => ({ ...s, monitorType: e.monitorType }))],
      [
        "InputAudioTracksChanged",
        (e) =>
          patchSource(e.inputName, (s) => ({
            ...s,
            tracks: Object.entries(e.inputAudioTracks as Record<string, boolean>).filter(([, on]) => on).map(([t]) => Number(t)),
          })),
      ],
      [
        "SourceFilterEnableStateChanged",
        (e) =>
          patchSource(e.sourceName, (s) => ({
            ...s,
            filters: s.filters.map((f) => (f.name === e.filterName ? { ...f, enabled: e.filterEnabled } : f)),
          })),
      ],
      ["CurrentProgramSceneChanged", (e) => setState((prev) => prev && { ...prev, programScene: e.sceneName })],
      [
        "SceneItemEnableStateChanged",
        (e) =>
          setState(
            (prev) =>
              prev && {
                ...prev,
                scenes: prev.scenes.map((sc) =>
                  sc.name === e.sceneName
                    ? { ...sc, items: sc.items.map((i) => (i.id === e.sceneItemId ? { ...i, enabled: e.sceneItemEnabled } : i)) }
                    : sc,
                ),
              },
          ),
      ],
      [
        "InputVolumeMeters",
        (e) => {
          const next: Record<string, ChannelLevels> = {};
          for (const input of e.inputs as { inputName: string; inputLevelsMul: number[][] }[]) {
            // inputLevelsMul is [channel][magnitude, peak, inputPeak]; use the post-fader peak.
            const [l, r] = input.inputLevelsMul;
            const left = meterPosition(l?.[1] ?? 0);
            next[input.inputName] = [left, r ? meterPosition(r[1]) : left];
          }
          setLevels(next);
        },
      ],
      ...STRUCTURE_EVENTS.map((name): [string, () => void] => [name, reload]),
    ];
    for (const [name, handler] of handlers) obs.on(name as any, handler);
    return () => {
      clearTimeout(reloadTimer.current);
      for (const [name, handler] of handlers) obs.off(name as any, handler);
    };
  }, [connected, reload, patchSource]);

  // Each setter updates the UI right away; the matching OBS event confirms it.
  const send = (p: Promise<unknown>) => p.catch((e: Error) => setError(`OBS 沒有接受這個變更：${e.message}`));

  return {
    state,
    levels,
    error,
    setVolume: (name, db) => {
      patchSource(name, (s) => ({ ...s, volumeDb: db }));
      send(obs.call("SetInputVolume", { inputName: name, inputVolumeDb: db }));
    },
    setMuted: (name, muted) => {
      patchSource(name, (s) => ({ ...s, muted }));
      send(obs.call("SetInputMute", { inputName: name, inputMuted: muted }));
    },
    setMonitorType: (name, monitorType) => {
      patchSource(name, (s) => ({ ...s, monitorType }));
      send(obs.call("SetInputAudioMonitorType", { inputName: name, monitorType }));
    },
    setFilterEnabled: (sourceName, filterName, filterEnabled) => {
      patchSource(sourceName, (s) => ({ ...s, filters: s.filters.map((f) => (f.name === filterName ? { ...f, enabled: filterEnabled } : f)) }));
      send(obs.call("SetSourceFilterEnabled", { sourceName, filterName, filterEnabled }));
    },
    addStreamTracks: (name) => {
      const source = state?.sources.find((s) => s.name === name);
      if (!source || !state) return;
      const inputAudioTracks = Object.fromEntries(state.streamTracks.map((t) => [String(t), true]));
      send(obs.call("SetInputAudioTracks", { inputName: name, inputAudioTracks }));
    },
    showInProgram: (items) => {
      for (const { sceneName, item } of items) {
        send(obs.call("SetSceneItemEnabled", { sceneName, sceneItemId: item.id, sceneItemEnabled: true }));
      }
    },
    switchScene: (sceneName) => {
      setState((prev) => prev && { ...prev, programScene: sceneName });
      send(obs.call("SetCurrentProgramScene", { sceneName }));
    },
  };
}
