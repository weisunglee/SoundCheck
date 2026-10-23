// Live audio state from Streamlabs Desktop, behind the same AudioBackend interface as OBS.
// Its local API can only set volume, mute, scene and item visibility; the rest is read-only,
// and it sends no audio-level or audio-setting events, so volumes and mutes are polled.
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "./i18n";
import { INPUT_KIND_LABELS, type AudioBackend, type CaptureSettings, type ObsAudioState } from "./obsAudio";
import { CAPABILITIES } from "./software";
import { iecDbToDeflection, streamlabs } from "./streamlabs";
import { CAPTURE_KIND_SET } from "./systemAudio";
import type { AudioSource, MonitorType, Scene } from "./types";

interface SlSource {
  sourceId: string;
  name: string;
  type: string;
  audio: boolean;
  channel?: number | null;
  resourceId: string;
}

interface SlAudioSource {
  sourceId: string;
  name: string;
  fader: { db: number; deflection: number };
  audioMixers: number;
  monitoringType: number;
  syncOffset: number;
  muted: boolean;
  mixerHidden: boolean;
  resourceId: string;
}

interface SlNode {
  id: string;
  sceneNodeType: "item" | "folder";
  sceneItemId?: string;
  sourceId?: string;
  visible?: boolean;
  resourceId?: string;
}

interface SlScene {
  id: string;
  name: string;
  nodes: SlNode[];
  resourceId: string;
}

/** obs.EMonitoringType: 0 off, 1 monitor only, 2 monitor and output. */
const MONITOR_TYPES: MonitorType[] = [
  "OBS_MONITORING_TYPE_NONE",
  "OBS_MONITORING_TYPE_MONITOR_ONLY",
  "OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT",
];

const POLL_MS = 1000;
const RELOAD_DEBOUNCE_MS = 300;
const STRUCTURE_EVENTS: [string, string][] = [
  ["ScenesService", "sceneAdded"],
  ["ScenesService", "sceneRemoved"],
  ["ScenesService", "itemAdded"],
  ["ScenesService", "itemRemoved"],
  ["ScenesService", "itemUpdated"],
  ["SourcesService", "sourceAdded"],
  ["SourcesService", "sourceRemoved"],
  ["SourcesService", "sourceUpdated"],
];

/** Resource ids behind the names the UI uses. */
interface Ids {
  audio: Map<string, string>;
  /** Scene name → its id and resourceId. */
  scenes: Map<string, { id: string; resource: string }>;
  /** "sceneName/sceneItemId" → SceneItem resourceId. */
  items: Map<string, string>;
  sources: Map<string, string>;
}

const tracksOf = (mixers: number) => [1, 2, 3, 4, 5, 6].filter((t) => mixers & (1 << (t - 1)));

function toSource(audio: SlAudioSource, source: SlSource | undefined): AudioSource {
  const kind = source?.type ?? "";
  return {
    name: audio.name,
    device: INPUT_KIND_LABELS[kind] ?? kind,
    inputKind: kind,
    volumeDb: Math.max(-100, audio.fader.db),
    muted: audio.muted,
    balance: 0.5,
    syncOffsetMs: audio.syncOffset,
    monitorType: MONITOR_TYPES[audio.monitoringType] ?? "OBS_MONITORING_TYPE_NONE",
    filters: [],
    tracks: tracksOf(audio.audioMixers),
    // Global devices (Settings → Audio) sit on an output channel.
    global: source?.channel != null,
  };
}

async function loadState(): Promise<{ state: ObsAudioState; ids: Ids }> {
  const [scenes, audio, sources, activeId] = await Promise.all([
    streamlabs.request<SlScene[]>("ScenesService", "getScenes"),
    streamlabs.request<SlAudioSource[]>("AudioService", "getSources"),
    streamlabs.request<SlSource[]>("SourcesService", "getSources"),
    streamlabs.request<string>("ScenesService", "activeSceneId"),
  ]);
  const byId = new Map(sources.map((s) => [s.sourceId, s]));
  const sceneIds = new Set(scenes.map((s) => s.id));
  const ids: Ids = { audio: new Map(), scenes: new Map(), items: new Map(), sources: new Map() };

  const appScenes: Scene[] = scenes.map((scene) => {
    ids.scenes.set(scene.name, { id: scene.id, resource: scene.resourceId });
    return {
      name: scene.name,
      items: scene.nodes
        .filter((n) => n.sceneNodeType === "item" && n.sourceId)
        .map((n) => {
          if (n.resourceId) ids.items.set(`${scene.name}/${n.sceneItemId ?? n.id}`, n.resourceId);
          return {
            id: n.sceneItemId ?? n.id,
            sourceName: byId.get(n.sourceId!)?.name ?? n.sourceId!,
            enabled: n.visible ?? true,
            // A nested scene is a scene item whose source is another scene.
            isScene: sceneIds.has(n.sourceId!),
          };
        }),
    };
  });

  const appSources = audio
    .filter((a) => !a.mixerHidden)
    .map((a) => {
      ids.audio.set(a.name, a.resourceId);
      const source = byId.get(a.sourceId);
      if (source) ids.sources.set(a.name, source.resourceId);
      return toSource(a, source);
    });

  return {
    state: {
      sources: appSources,
      scenes: appScenes,
      sceneOrder: scenes.map((s) => s.name),
      programScene: scenes.find((s) => s.id === activeId)?.name ?? "",
      // Streamlabs streams track 1 (track 2 is its optional VOD track).
      streamTracks: [1],
      pluginAvailable: false,
      pluginVersion: null,
    },
    ids,
  };
}

export function useStreamlabsAudio(connected: boolean): AudioBackend {
  const [state, setState] = useState<ObsAudioState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = useRef<Ids>({ audio: new Map(), scenes: new Map(), items: new Map(), sources: new Map() });
  const reloadTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const reload = useCallback(() => {
    clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => {
      loadState()
        .then((r) => {
          ids.current = r.ids;
          setState(r.state);
          setError(null);
        })
        .catch((e: Error) => setError(t("讀取直播軟體狀態失敗：{error}", { error: e.message })));
    }, RELOAD_DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    if (!connected) {
      setState(null);
      return;
    }
    reload();
    let alive = true;

    streamlabs
      .subscribe("ScenesService", "sceneSwitched", (scene: SlScene) => {
        if (alive) setState((prev) => prev && { ...prev, programScene: scene.name });
      })
      .catch(() => {});
    for (const [service, channel] of STRUCTURE_EVENTS) {
      streamlabs.subscribe(service, channel, () => alive && reload()).catch(() => {});
    }

    // No events for fader or mute changes made in Streamlabs, so poll the audio sources.
    const poll = setInterval(async () => {
      try {
        const audio = await streamlabs.request<SlAudioSource[]>("AudioService", "getSources");
        if (!alive) return;
        const byName = new Map(audio.map((a) => [a.name, a]));
        setState(
          (prev) =>
            prev && {
              ...prev,
              sources: prev.sources.map((s) => {
                const a = byName.get(s.name);
                return a
                  ? {
                      ...s,
                      volumeDb: Math.max(-100, a.fader.db),
                      muted: a.muted,
                      monitorType: MONITOR_TYPES[a.monitoringType] ?? s.monitorType,
                      tracks: tracksOf(a.audioMixers),
                    }
                  : s;
              }),
            },
        );
      } catch {
        // The connection's close event handles a lost connection.
      }
    }, POLL_MS);

    return () => {
      alive = false;
      clearTimeout(reloadTimer.current);
      clearInterval(poll);
    };
  }, [connected, reload]);

  const patch = (name: string, change: Partial<AudioSource>) =>
    setState((prev) => prev && { ...prev, sources: prev.sources.map((s) => (s.name === name ? { ...s, ...change } : s)) });
  const send = (p: Promise<unknown>) => p.catch((e: Error) => setError(t("直播軟體沒有接受這個變更：{error}", { error: e.message })));
  const unsupported = () => {};

  return {
    capabilities: CAPABILITIES.streamlabs,
    state,
    levels: {},
    inputDb: {},
    error,
    setVolume: (name, db) => {
      const resource = ids.current.audio.get(name);
      if (!resource) return;
      patch(name, { volumeDb: db });
      send(streamlabs.request(resource, "setDeflection", iecDbToDeflection(db)));
    },
    setMuted: (name, muted) => {
      const resource = ids.current.audio.get(name);
      if (!resource) return;
      patch(name, { muted });
      send(streamlabs.request(resource, "setMuted", muted));
    },
    setMonitorType: unsupported,
    setBalance: unsupported,
    setSyncOffset: unsupported,
    setFilterEnabled: unsupported,
    addStreamTracks: unsupported,
    showInProgram: (items) => {
      for (const { sceneName, item } of items) {
        const resource = ids.current.items.get(`${sceneName}/${item.id}`);
        if (resource) send(streamlabs.request(resource, "setVisibility", true));
      }
    },
    switchScene: (sceneName) => {
      const scene = ids.current.scenes.get(sceneName);
      if (!scene) return;
      setState((prev) => prev && { ...prev, programScene: sceneName });
      send(streamlabs.request("ScenesService", "makeSceneActive", scene.id));
    },
    listInputKinds: async () => {
      const list = await streamlabs.request<{ value: string }[]>("SourcesService", "getAvailableSourcesTypesList");
      return new Set(list.map((k) => k.value));
    },
    createSource: async (name, kind, settings, scenes) => {
      const source = await streamlabs.request<SlSource>("SourcesService", "createSource", name, kind, settings);
      for (const sceneName of scenes) {
        const scene = ids.current.scenes.get(sceneName);
        if (scene) await streamlabs.request(scene.resource, "addSource", source.sourceId);
      }
    },
    captureSettings: async (sources) => {
      const result: CaptureSettings = new Map();
      await Promise.all(
        sources
          .filter((s) => CAPTURE_KIND_SET.has(s.inputKind))
          .map(async (s) => {
            const resource = ids.current.sources.get(s.name);
            if (!resource) return;
            const settings = await streamlabs.request<Record<string, any>>(resource, "getSettings").catch(() => null);
            if (settings) result.set(s.name, { kind: s.inputKind, settings });
          }),
      );
      return result;
    },
  };
}
