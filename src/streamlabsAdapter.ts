// Streamlabs Desktop behind the SoftwareAdapter interface, over its local API (streamlabs.ts).
//
// The documented API only sets volume, mute, scene and item visibility. Monitoring, tracks, sync
// offset and filters go through Streamlabs' own internal objects, which its API forwards calls to
// when the documented object lacks the method (AudioSource.setSettings, SourceFiltersService).
// tools/verify-streamlabs.ts checks those against a real install. There is no balance, and no
// way to read levels from outside, so the adapter has neither. The SoundCheck plugin's Streamlabs
// build (obs-plugin/src/plugin-streamlabs.cpp) brings the stream meter and sound test.
import { invoke } from "@tauri-apps/api/core";
import { AUDIO_FILTER_KINDS, type AudioState, type CaptureSettings, type FilterOps, INPUT_KIND_LABELS, type SoftwareAdapter } from "./adapter";
import { NotLoadedError, type PluginLink } from "./plugin";
import { iecDbToDeflection, streamlabs } from "./streamlabs";
import { CAPTURE_KIND_SET } from "./systemAudio";
import type { AudioSource, Filter, MonitorType, Scene } from "./types";

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

interface SlFilter {
  name: string;
  type: string;
  visible: boolean;
  settings: Record<string, any>;
}

/** obs.EMonitoringType: 0 off, 1 monitor only, 2 monitor and output. */
const MONITOR_TYPES: MonitorType[] = ["off", "monitorOnly", "monitorAndOutput"];

const FILTERS = "SourceFiltersService";
const FILTER_EVENTS = ["filterAdded", "filterRemoved", "filterUpdated", "filtersReordered"];
const STRUCTURE_EVENTS: [string, string][] = [
  ["ScenesService", "sceneAdded"],
  ["ScenesService", "sceneRemoved"],
  ["ScenesService", "itemAdded"],
  ["ScenesService", "itemRemoved"],
  ["ScenesService", "itemUpdated"],
  ["SourcesService", "sourceAdded"],
  ["SourcesService", "sourceRemoved"],
  ["SceneCollectionsService", "collectionSwitched"],
  ...FILTER_EVENTS.map((channel): [string, string] => [FILTERS, channel]),
];

/** Resource ids behind the names the app uses, from the latest load. */
interface Ids {
  audio: Map<string, string>;
  /** Scene name → its id and resourceId. */
  scenes: Map<string, { id: string; resource: string }>;
  /** "sceneName/sceneItemId" → SceneItem resourceId. */
  items: Map<string, string>;
  sources: Map<string, string>;
  /** Audio source name → sourceId, and back. */
  sourceIds: Map<string, string>;
  names: Map<string, string>;
  /** sourceId → name of every source, audio or not (to notice renames). */
  allNames: Map<string, string>;
}

const noIds = (): Ids => ({ audio: new Map(), scenes: new Map(), items: new Map(), sources: new Map(), sourceIds: new Map(), names: new Map(), allNames: new Map() });
let ids = noIds();

const tracksOf = (mixers: number) => [1, 2, 3, 4, 5, 6].filter((t) => mixers & (1 << (t - 1)));
const mixersOf = (tracks: number[]) => tracks.reduce((mask, t) => mask | (1 << (t - 1)), 0);

/** The fields AudioService reports when a source's audio settings change. */
const audioFields = (audio: SlAudioSource) => ({
  volumeDb: Math.max(-100, audio.fader.db),
  muted: audio.muted,
  monitorType: MONITOR_TYPES[audio.monitoringType] ?? "off",
  tracks: tracksOf(audio.audioMixers),
  syncOffsetMs: audio.syncOffset,
});

function sourceIdOf(name: string): string {
  const id = ids.sourceIds.get(name);
  if (!id) throw new Error(`Streamlabs has no audio source named "${name}"`);
  return id;
}

/** Calls a method of the audio source named `name`. */
function audioRequest(name: string, method: string, ...args: unknown[]): Promise<unknown> {
  const resource = ids.audio.get(name);
  return resource ? streamlabs.request(resource, method, ...args) : Promise.resolve();
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
  const next = noIds();
  for (const s of sources) next.allNames.set(s.sourceId, s.name);

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

  const shown = audio.filter((a) => !a.mixerHidden);
  const filters = await Promise.all(
    shown.map((a) => streamlabs.request<SlFilter[]>(FILTERS, "getFilters", a.sourceId).catch((): SlFilter[] => [])),
  );
  const appSources = shown.map((a, i): AudioSource => {
    next.audio.set(a.name, a.resourceId);
    next.sourceIds.set(a.name, a.sourceId);
    next.names.set(a.sourceId, a.name);
    const source = byId.get(a.sourceId);
    if (source) next.sources.set(a.name, source.resourceId);
    const kind = source?.type ?? "";
    return {
      name: a.name,
      device: INPUT_KIND_LABELS[kind] ?? kind,
      inputKind: kind,
      ...audioFields(a),
      balance: 0.5,
      filters: filters[i]
        .filter((f) => AUDIO_FILTER_KINDS.has(f.type))
        .map((f): Filter => ({ name: f.name, kind: f.type, enabled: f.visible })),
      // Global devices (Settings → Audio) sit on an output channel.
      global: source?.channel != null,
    };
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

const filters: FilterOps = {
  async list(source) {
    const id = sourceIdOf(source);
    const list = await streamlabs.request<SlFilter[]>(FILTERS, "getFilters", id);
    // Streamlabs' own copy of the settings holds only what it was last sent; the properties
    // form reads the filter itself, defaults included.
    return Promise.all(
      list.map(async (f, index) => {
        const form = await streamlabs
          .request<{ name?: string; value?: unknown }[]>(FILTERS, "getPropertiesFormData", id, f.name)
          .catch(() => []);
        const current = Object.fromEntries(form.filter((p) => p.name && p.value !== undefined).map((p) => [p.name!, p.value]));
        return { name: f.name, kind: f.type, enabled: f.visible, index, settings: { ...f.settings, ...current } };
      }),
    );
  },
  async create(source, name, kind, settings) {
    await streamlabs.request(FILTERS, "add", sourceIdOf(source), kind, name, settings);
  },
  async remove(source, name) {
    await streamlabs.request(FILTERS, "remove", sourceIdOf(source), name);
  },
  async move(source, name, index) {
    const list = await streamlabs.request<SlFilter[]>(FILTERS, "getFilters", sourceIdOf(source));
    const delta = index - list.findIndex((f) => f.name === name);
    if (delta !== 0) await streamlabs.request(FILTERS, "setOrder", sourceIdOf(source), name, delta);
  },
  async setSettings(source, name, settings, replace = false) {
    // Streamlabs stores exactly what it is sent, so always send the whole set.
    const current = replace ? {} : ((await filters.list(source)).find((f) => f.name === name)?.settings ?? {});
    await streamlabs.request(FILTERS, "setSettings", sourceIdOf(source), name, { ...current, ...settings });
  },
  async setEnabled(source, name, enabled) {
    await streamlabs.request(FILTERS, "setVisibility", sourceIdOf(source), name, enabled);
  },
  watch(source, onChange) {
    const offs = FILTER_EVENTS.map((channel) =>
      streamlabs.on(FILTERS, channel, (e?: { sourceId?: string }) => {
        // filtersReordered doesn't say which source.
        if (!e?.sourceId || e.sourceId === ids.sourceIds.get(source)) onChange();
      }),
    );
    return () => offs.forEach((off) => off());
  },
};

const PLUGIN_MODULE = "soundcheck-streamlabs.dll";
/** How long a freshly loaded plugin may take to open its control port. */
const PLUGIN_LOAD_WAIT_MS = 3000;

/** Set once this connection has asked Streamlabs to load the installed plugin. */
let pluginLoad: Promise<boolean> | null = null;
streamlabs.onClose(() => {
  pluginLoad = null;
});

const sendToPlugin = (requestType: string, requestData: unknown) =>
  invoke<{ ok?: boolean; error?: string }>("streamlabs_plugin_request", { requestType, requestData }).catch((e) => {
    throw String(e) === "notLoaded" ? new NotLoadedError() : new Error(String(e));
  });

/**
 * Streamlabs loads the plugin at startup; one installed while it runs is loaded through
 * ObsUserPluginsService.initializeModule. That happens at most once per connection and only
 * when the plugin answers nothing, since loading a module twice would run it twice.
 */
export function loadStreamlabsPlugin(): Promise<boolean> {
  pluginLoad ??= (async () => {
    const { installed } = await invoke<{ installed: boolean }>("streamlabs_plugin_status");
    if (!installed) {
      // Nothing to load yet; try again once something is installed.
      pluginLoad = null;
      return false;
    }
    await streamlabs.request("ObsUserPluginsService", "initializeModule", PLUGIN_MODULE);
    for (let waited = 0; waited < PLUGIN_LOAD_WAIT_MS; waited += 200) {
      if (await sendToPlugin("GetInfo", {}).then(() => true, () => false)) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  })();
  return pluginLoad;
}

const pluginLink: PluginLink = {
  async request(requestType, requestData) {
    try {
      return await sendToPlugin(requestType, requestData);
    } catch (e) {
      if (!(e instanceof NotLoadedError) || !(await loadStreamlabsPlugin())) throw e;
      return sendToPlugin(requestType, requestData);
    }
  },
};

export const streamlabsAdapter: SoftwareAdapter = {
  id: "streamlabs",
  meters: false,
  load,

  watch(changes) {
    const offs = [
      streamlabs.on("ScenesService", "sceneSwitched", (scene: SlScene) => changes.programScene(scene.name)),
      // Fader, monitoring, tracks and sync offset changes, including ones made in Streamlabs.
      streamlabs.on("AudioService", "audioSourceUpdated", (a: SlAudioSource) => {
        const name = ids.names.get(a.sourceId);
        if (name) changes.patchSource(name, audioFields(a));
      }),
      // Mutes and renames; audioSourceUpdated doesn't report mutes. A reload costs one of the
      // API's few points per second (getScenes), so a mute is applied directly.
      streamlabs.on("SourcesService", "sourceUpdated", (s: { sourceId: string; name: string; muted?: boolean }) => {
        if (ids.allNames.get(s.sourceId) !== s.name) changes.reload();
        else if (s.muted !== undefined) changes.patchSource(s.name, { muted: s.muted });
      }),
      ...STRUCTURE_EVENTS.map(([service, channel]) => streamlabs.on(service, channel, changes.reload)),
    ];
    return () => offs.forEach((off) => off());
  },

  async setVolume(name, db) {
    await audioRequest(name, "setDeflection", iecDbToDeflection(db));
  },
  async setMuted(name, muted) {
    await audioRequest(name, "setMuted", muted);
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

  async setMonitorType(name, type) {
    await audioRequest(name, "setSettings", { monitoringType: MONITOR_TYPES.indexOf(type) });
  },
  async setTracks(name, tracks) {
    await audioRequest(name, "setSettings", { audioMixers: mixersOf(tracks) });
  },
  async setSyncOffset(name, ms) {
    await audioRequest(name, "setSettings", { syncOffset: ms });
  },
  filters,
  sceneCollection: async () => (await streamlabs.request<{ name: string }>("SceneCollectionsService", "activeCollection")).name,
  plugin: pluginLink,
};
