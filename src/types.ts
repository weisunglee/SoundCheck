// Values match obs-websocket's monitorType strings so they can be sent as-is.
export type MonitorType =
  | "OBS_MONITORING_TYPE_NONE"
  | "OBS_MONITORING_TYPE_MONITOR_ONLY"
  | "OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT";

export interface Filter {
  name: string;
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
  sourceName: string;
  /** The eye toggle in OBS. */
  enabled: boolean;
  /** True when the item is a nested scene or group, whose items count as part of this scene. */
  isScene?: boolean;
}

export interface Scene {
  name: string;
  items: SceneItem[];
}

/** Why a source can or can't be heard on stream in the current program scene. */
export type SourceStatus = "live" | "hidden" | "muted" | "offStream" | "notInScene";

/** Per-channel level, 0..1 (linear, already mapped from dB for display). */
export type ChannelLevels = [number, number];
