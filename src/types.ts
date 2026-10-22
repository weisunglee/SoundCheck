// Values match obs-websocket's monitorType strings so they can be sent as-is.
export type MonitorType =
  | "OBS_MONITORING_TYPE_NONE"
  | "OBS_MONITORING_TYPE_MONITOR_ONLY"
  | "OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT";

export interface Filter {
  name: string;
  /** OBS filter kind, e.g. "noise_gate_filter". */
  kind: string;
  enabled: boolean;
}

export interface AudioSource {
  name: string;
  /** What the user recognises it as, e.g. "Shure MV7" or "Spotify". */
  device: string;
  volumeDb: number;
  muted: boolean;
  monitorType: MonitorType;
  filters: Filter[];
  /** Audio tracks (1-6) this source is sent to. */
  tracks: number[];
  /** Desktop/mic devices added in OBS Settings → Audio; present in every scene. */
  global: boolean;
}

export interface SceneItem {
  /** OBS sceneItemId, unique within its scene. */
  id: number;
  sourceName: string;
  /** The eye toggle in OBS. */
  enabled: boolean;
  /** True when the item is a nested scene or group, whose items count as part of this scene. */
  isScene?: boolean;
}

export interface Scene {
  name: string;
  items: SceneItem[];
  /** Groups behave like nested scenes but are not listed as switchable scenes. */
  isGroup?: boolean;
}

/** Why a source can or can't be heard on stream in the current program scene. */
export type SourceStatus = "live" | "hidden" | "muted" | "offStream" | "notInScene";

/** Per-channel meter position, 0..1, linear in dB from -60 dBFS to 0 dBFS. */
export type ChannelLevels = [number, number];
