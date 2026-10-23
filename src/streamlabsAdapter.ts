// Streamlabs Desktop behind the SoftwareAdapter interface, over its local API (streamlabs.ts).
// The API can only set volume, mute, scene and item visibility, so the other setters are left
// out; it sends no audio-level or audio-setting events, so volumes and mutes are polled.
import { type AudioState, type CaptureSettings, INPUT_KIND_LABELS, type SoftwareAdapter } from "./adapter";
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
const MONITOR_TYPES: MonitorType[] = ["off", "monitorOnly", "monitorAndOutput"];

const POLL_MS = 1000;
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

/** Resource ids behind the names the app uses, from the latest load. */
interface Ids {
  audio: Map<string, string>;
  /** Scene name → its id and resourceId. */
  scenes: Map<string, { id: string; resource: string }>;
  /** "sceneName/sceneItemId" → SceneItem resourceId. */
  items: Map<string, string>;
  sources: Map<string, string>;
}

let ids: Ids = { audio: new Map(), scenes: new Map(), items: new Map(), sources: new Map() };

const tracksOf = (mixers: number) => [1, 2, 3, 4, 5, 6].filter((t) => mixers & (1 << (t - 1)));

/** The fields the poll refreshes. */
const audioFields = (audio: SlAudioSource) => ({
  volumeDb: Math.max(-100, audio.fader.db),
  muted: audio.muted,
  monitorType: MONITOR_TYPES[audio.monitoringType] ?? "off",
  tracks: tracksOf(audio.audioMixers),
});

function toSource(audio: SlAudioSource, source: SlSource | undefined): AudioSource {
  const kind = source?.type ?? "";
  return {
    name: audio.name,
    device: INPUT_KIND_LABELS[kind] ?? kind,
    inputKind: kind,
    ...audioFields(audio),
    balance: 0.5,
    syncOffsetMs: audio.syncOffset,
    filters: [],
    // Global devices (Settings → Audio) sit on an output channel.
    global: source?.channel != null,
  };
}

async function load(): Promise<AudioState> {
  const [scenes, audio, sources, activeId] = await Promise.all([
    streamlabs.request<SlScene[]>("ScenesService", "getScenes"),
    streamlabs.request<SlAudioSource[]>("AudioService", "getSources"),
    streamlabs.request<SlSource[]>("SourcesService", "getSources"),
    streamlabs.request<string>("ScenesService", "activeSceneId"),
  ]);
  const byId = new Map(sources.map((s) => [s.sourceId, s]));
  const sceneIds = new Set(scenes.map((s) => s.id));
  const next: Ids = { audio: new Map(), scenes: new Map(), items: new Map(), sources: new Map() };

  const appScenes: Scene[] = scenes.map((scene) => {
    next.scenes.set(scene.name, { id: scene.id, resource: scene.resourceId });
    return {
      name: scene.name,
      items: scene.nodes
        .filter((n) => n.sceneNodeType === "item" && n.sourceId)
        .map((n) => {
          if (n.resourceId) next.items.set(`${scene.name}/${n.sceneItemId ?? n.id}`, n.resourceId);
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
      next.audio.set(a.name, a.resourceId);
      const source = byId.get(a.sourceId);
      if (source) next.sources.set(a.name, source.resourceId);
      return toSource(a, source);
    });

  ids = next;
  return {
    sources: appSources,
    scenes: appScenes,
    sceneOrder: scenes.map((s) => s.name),
    programScene: scenes.find((s) => s.id === activeId)?.name ?? "",
    // Streamlabs streams track 1 (track 2 is its optional VOD track).
    streamTracks: [1],
  };
}

export const streamlabsAdapter: SoftwareAdapter = {
  id: "streamlabs",
  meters: false,
  load,

  watch(changes) {
    // The client has no unsubscribe; subscriptions end with the connection, so mute them until then.
    let alive = true;
    streamlabs
      .subscribe("ScenesService", "sceneSwitched", (scene: SlScene) => alive && changes.programScene(scene.name))
      .catch(() => {});
    for (const [service, channel] of STRUCTURE_EVENTS) {
      streamlabs.subscribe(service, channel, () => alive && changes.reload()).catch(() => {});
    }

    // No events for fader or mute changes made in Streamlabs, so poll the audio sources.
    const poll = setInterval(async () => {
      try {
        const audio = await streamlabs.request<SlAudioSource[]>("AudioService", "getSources");
        if (alive) for (const a of audio) changes.patchSource(a.name, audioFields(a));
      } catch {
        // The connection's close event handles a lost connection.
      }
    }, POLL_MS);

    return () => {
      alive = false;
      clearInterval(poll);
    };
  },

  async setVolume(name, db) {
    const resource = ids.audio.get(name);
    if (resource) await streamlabs.request(resource, "setDeflection", iecDbToDeflection(db));
  },
  async setMuted(name, muted) {
    const resource = ids.audio.get(name);
    if (resource) await streamlabs.request(resource, "setMuted", muted);
  },
  async switchScene(sceneName) {
    const scene = ids.scenes.get(sceneName);
    if (scene) await streamlabs.request("ScenesService", "makeSceneActive", scene.id);
  },
  async setItemVisible(sceneName, item, visible) {
    const resource = ids.items.get(`${sceneName}/${item.id}`);
    if (resource) await streamlabs.request(resource, "setVisibility", visible);
  },
  async listInputKinds() {
    const list = await streamlabs.request<{ value: string }[]>("SourcesService", "getAvailableSourcesTypesList");
    return new Set(list.map((k) => k.value));
  },
  async createSource(name, kind, settings, scenes) {
    const source = await streamlabs.request<SlSource>("SourcesService", "createSource", name, kind, settings);
    for (const sceneName of scenes) {
      const scene = ids.scenes.get(sceneName);
      if (scene) await streamlabs.request(scene.resource, "addSource", source.sourceId);
    }
  },
  async captureSettings(sources) {
    const result: CaptureSettings = new Map();
    await Promise.all(
      sources
        .filter((s) => CAPTURE_KIND_SET.has(s.inputKind))
        .map(async (s) => {
          const resource = ids.sources.get(s.name);
          if (!resource) return;
          const settings = await streamlabs.request<Record<string, any>>(resource, "getSettings").catch(() => null);
          if (settings) result.set(s.name, { kind: s.inputKind, settings });
        }),
    );
    return result;
  },
};
