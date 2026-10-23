/** Where a source's sound goes besides the stream tracks: nowhere, the user's headphones instead, or both. */
export type MonitorType = "off" | "monitorOnly" | "monitorAndOutput";

export interface Filter {
  name: string;
  /** libobs filter kind, e.g. "noise_gate_filter". */
  kind: string;
  enabled: boolean;
}

export interface AudioSource {
  name: string;
  /** The kind of source in words the user recognises, e.g. "應用程式音訊擷取". */
  device: string;
  /** libobs input kind without version suffix, e.g. "wasapi_input_capture". */
  inputKind: string;
  volumeDb: number;
  muted: boolean;
  /** Stereo balance: 0 is full left, 0.5 centre, 1 full right. */
  balance: number;
  /** Positive delays the audio, negative plays it earlier (milliseconds). */
  syncOffsetMs: number;
  monitorType: MonitorType;
  filters: Filter[];
  /** Audio tracks (1-6) this source is sent to. */
  tracks: number[];
  /** Desktop/mic devices added in the software's audio settings; present in every scene. */
  global: boolean;
}

export interface SceneItem {
  /** The software's id for the item, unique within its scene (a number in OBS, a string in Streamlabs). */
  id: number | string;
  sourceName: string;
  /** The eye toggle in the software's source list. */
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
export type SourceStatus = "live" | "hidden" | "muted" | "monitorOnly" | "offStream" | "notInScene";

/** Per-channel meter position, 0..1, linear in dB from -60 dBFS to 0 dBFS. */
export type ChannelLevels = [number, number];
