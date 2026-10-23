// The seam between SoundCheck and a streaming software. Each program (OBS, Streamlabs) has one
// adapter; everything above it (src/audio.ts, filters, profiles, the UI) only knows this file.
// An adapter leaves out the operations its program can't do, and capabilitiesOf() turns that
// into what the UI shows, so "unsupported" is stated in exactly one place.
import { msg } from "./i18n";
import type { SoftwareId } from "./software";
import type { AudioSource, ChannelLevels, MonitorType, Scene, SceneItem } from "./types";

export interface AudioState {
  sources: AudioSource[];
  scenes: Scene[];
  /** Switchable scenes in the order the program shows them (groups excluded). */
  sceneOrder: string[];
  programScene: string;
  /** 1-based tracks the stream encodes. */
  streamTracks: number[];
}

/** Settings of inputs that capture a device or app, keyed by source name. */
export type CaptureSettings = Map<string, { kind: string; settings: Record<string, any> }>;

/** One filter on a source, with its full settings, in chain order. */
export interface SourceFilter {
  name: string;
  kind: string;
  enabled: boolean;
  /** Position among all of the source's filters, including video ones. */
  index: number;
  /** The program's defaults merged with this filter's own settings. */
  settings: Record<string, any>;
}

export type FilterSettings = { [key: string]: any };

/** Filter operations on a source. Kept to what the program does; ordering policy is in filters.ts. */
export interface FilterOps {
  list(source: string): Promise<SourceFilter[]>;
  create(source: string, name: string, kind: string, settings: FilterSettings): Promise<void>;
  remove(source: string, name: string): Promise<void>;
  rename(source: string, name: string, newName: string): Promise<void>;
  /** Moves the filter to `index` among all of the source's filters. */
  move(source: string, name: string, index: number): Promise<void>;
  /** Merges `settings` into the filter's, or replaces them all when `replace` is set. */
  setSettings(source: string, name: string, settings: FilterSettings, replace?: boolean): Promise<void>;
  setEnabled(source: string, name: string, enabled: boolean): Promise<void>;
  /** Calls `onChange` when a filter is added, removed, renamed, reordered or toggled on `source`. */
  watch(source: string, onChange: () => void): () => void;
}

/** What an adapter reports while watched; the state module applies these to its copy. */
export interface Changes {
  /** Something structural changed (scenes, items, sources, filters); load everything again. */
  reload(): void;
  /** Changes some fields of a source; a function gets the current source. Unknown names are ignored. */
  patchSource(name: string, patch: Partial<AudioSource> | ((source: AudioSource) => Partial<AudioSource>)): void;
  /** A scene item was shown or hidden. */
  patchItem(sceneName: string, itemId: SceneItem["id"], enabled: boolean): void;
  programScene(sceneName: string): void;
  /** Meter positions (0..1 over -60..0 dB) and pre-fader input peaks in dBFS, for adapters with meters. */
  levels(levels: Record<string, ChannelLevels>, inputDb: Record<string, number>): void;
}

export interface SoftwareAdapter {
  id: SoftwareId;
  /** Whether `watch` reports live levels. */
  meters: boolean;
  load(): Promise<AudioState>;
  /** Starts reporting changes; returns a function that stops. */
  watch(changes: Changes): () => void;

  setVolume(source: string, db: number): Promise<void>;
  setMuted(source: string, muted: boolean): Promise<void>;
  switchScene(scene: string): Promise<void>;
  setItemVisible(scene: string, item: SceneItem, visible: boolean): Promise<void>;
  /** Input kinds (unversioned) the program can create. */
  listInputKinds(): Promise<Set<string>>;
  /** Creates an input and adds it to each of `scenes`. */
  createSource(name: string, kind: string, settings: Record<string, string | number>, scenes: string[]): Promise<void>;
  captureSettings(sources: AudioSource[]): Promise<CaptureSettings>;

  // Optional: left out when the program can't do it.
  setMonitorType?(source: string, type: MonitorType): Promise<void>;
  setTracks?(source: string, tracks: number[]): Promise<void>;
  setBalance?(source: string, balance: number): Promise<void>;
  setSyncOffset?(source: string, ms: number): Promise<void>;
  /** Lowest and highest sync offset in ms the program accepts; requests are clamped to it. */
  syncOffsetRange?: [number, number];
  filters?: FilterOps;
  /** Name of the current scene collection; profiles warn when applied in another one. */
  sceneCollection?(): Promise<string>;
}

export interface Capabilities {
  meters: boolean;
  monitoringControl: boolean;
  tracksControl: boolean;
  balance: boolean;
  syncOffset: boolean;
  filters: boolean;
  /** The SoundCheck plugin (sound test, stream meter, installer) exists for OBS only. */
  plugin: boolean;
  /** Profiles save and restore everything above, so they need all of it. */
  profiles: boolean;
}

export function capabilitiesOf(adapter: SoftwareAdapter): Capabilities {
  const caps = {
    meters: adapter.meters,
    monitoringControl: Boolean(adapter.setMonitorType),
    tracksControl: Boolean(adapter.setTracks),
    balance: Boolean(adapter.setBalance),
    syncOffset: Boolean(adapter.setSyncOffset),
    filters: Boolean(adapter.filters),
    plugin: adapter.id === "obs",
  };
  return { ...caps, profiles: caps.monitoringControl && caps.tracksControl && caps.balance && caps.syncOffset && caps.filters };
}

/** Names users see for input kinds; OBS and Streamlabs share libobs kinds (translated where shown). */
export const INPUT_KIND_LABELS: Record<string, string> = {
  wasapi_input_capture: msg("音訊輸入擷取"),
  wasapi_output_capture: msg("音訊輸出擷取"),
  wasapi_process_output_capture: msg("應用程式音訊擷取"),
  coreaudio_input_capture: msg("音訊輸入擷取"),
  coreaudio_output_capture: msg("音訊輸出擷取"),
  sck_audio_capture: msg("macOS 音訊擷取"),
  pulse_input_capture: msg("音訊輸入擷取"),
  pulse_output_capture: msg("音訊輸出擷取"),
  ffmpeg_source: msg("媒體來源"),
  vlc_source: msg("VLC 影片來源"),
  browser_source: msg("瀏覽器來源"),
  dshow_input: msg("視訊擷取裝置"),
  av_capture_input: msg("視訊擷取裝置"),
  game_capture: msg("遊戲擷取"),
  window_capture: msg("視窗擷取"),
  screen_capture: msg("螢幕擷取"),
  ndi_source: msg("NDI 來源"),
};
