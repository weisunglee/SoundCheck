// The SoundCheck plugin as the app sees it: the requests it answers (obs-plugin/src/requests.cpp),
// how they reach it in each streaming software (a PluginLink, from the adapter), what is
// installed on disk, and what the user needs to do about it.
import { invoke } from "@tauri-apps/api/core";
import { OBSWebSocketError } from "obs-websocket-js";
import { useEffect, useState } from "react";
import { t } from "./i18n";
import type { ConnectionState } from "./connection";
import type { SoftwareId } from "./software";
import { obs } from "./obsClient";

type RequestData = { [key: string]: string | number | boolean };

/** Carries one request to the plugin and back; rejects with NotLoadedError when it isn't loaded. */
export interface PluginLink {
  request(requestType: string, requestData: RequestData): Promise<{ ok?: boolean; error?: string }>;
}

export class NotLoadedError extends Error {
  constructor() {
    super(t("直播軟體裡沒有安裝 SoundCheck 外掛，試音需要它。"));
  }
}

/** obs-websocket answers 600 "No vendor was found by that name." when the plugin isn't loaded. */
const NO_VENDOR = 600;

/** OBS: obs-websocket vendor requests to the "soundcheck" vendor (obs-plugin/src/plugin-obs.cpp). */
export const obsPluginLink: PluginLink = {
  async request(requestType, requestData) {
    try {
      const { responseData } = await obs.call("CallVendorRequest", { vendorName: "soundcheck", requestType, requestData });
      return responseData as { ok?: boolean; error?: string };
    } catch (e) {
      if (e instanceof OBSWebSocketError && e.code === NO_VENDOR && /vendor/i.test(e.message)) throw new NotLoadedError();
      throw e;
    }
  },
};

export interface PluginInfo {
  pluginVersion: string;
  streaming: boolean;
  /** 1-based tracks the stream encodes. */
  streamTracks: number[];
  /** "output", "config-advanced", "config-simple" or "default". */
  streamTracksOrigin: string;
  tapRunning: boolean;
  streamAudioPaused: boolean;
}

export interface TapStarted {
  port: number;
  track: number;
  sampleRate: number;
  channels: number;
}

/** One read of the voice analyzer's recording (obs-plugin/src/voice-analyzer.cpp). */
export interface VoiceCaptureChunk {
  capturing: boolean;
  sampleRate: number;
  /** First frame in `data`, the frames in it, all frames recorded so far, and the frames asked for. */
  from: number;
  frames: number;
  total: number;
  target: number;
  /** Largest sample magnitude in `data`, 0..1. */
  peak: number;
  /** Mono 32-bit float little-endian PCM, base64. */
  data: string;
}

/** Filter kinds the plugin adds (obs-plugin/src/voice-filters.hpp). */
export const VOICE_EQ_KIND = "soundcheck_voice_eq";
export const VOICE_ANALYZER_KIND = "soundcheck_voice_analyzer";

export type Plugin = ReturnType<typeof createPlugin>;

/** The plugin's requests over `link`. Every call rejects with a readable error if the plugin isn't loaded. */
export function createPlugin(link: PluginLink) {
  const request = async <T>(requestType: string, requestData: RequestData = {}): Promise<T> => {
    const data = await link.request(requestType, requestData);
    if (data.ok === false) throw new Error(data.error ?? t("外掛回報失敗"));
    return data as T;
  };
  return {
    async info(): Promise<PluginInfo> {
      const raw = await request<Omit<PluginInfo, "streamTracks"> & { streamTracks: { track: number }[] }>("GetInfo");
      return { ...raw, streamTracks: raw.streamTracks.map((s) => s.track) };
    },
    /** Starts copying `track` (default: the first stream track) to a local socket; see stream_tap.rs. */
    startTap: (track?: number) => request<TapStarted>("StartTap", track ? { track } : {}),
    stopTap: () => request("StopTap"),
    /** Takes every source off the stream tracks until resumed, or until heartbeats stop for `timeoutMs`. */
    pauseStreamAudio: (timeoutMs: number) => request("PauseStreamAudio", { timeoutMs }),
    heartbeat: () => request("Heartbeat"),
    resumeStreamAudio: () => request("ResumeStreamAudio"),
    /** Starts recording `seconds` with the voice analyzer filter on `source`. */
    startVoiceCapture: (source: string, seconds: number) => request<{ sampleRate: number }>("StartVoiceCapture", { source, seconds }),
    /** What the analyzer on `source` recorded from frame `from` on (at most a second per call). */
    readVoiceCapture: (source: string, from: number) => request<VoiceCaptureChunk>("ReadVoiceCapture", { source, from }),
    stopVoiceCapture: (source: string) => request("StopVoiceCapture", { source }),
  };
}

/** The plugin of the OBS that obs-websocket is connected to. */
export const obsPlugin = createPlugin(obsPluginLink);

/**
 * What `plugin` reports: null when it isn't loaded, undefined until it has answered or while
 * `plugin` is null. Asked again when `plugin` or `refresh` changes (a new connection, or a new
 * file installed); a plugin loads only when the software starts or is told to, so one answer
 * holds until then.
 */
export function usePluginInfo(plugin: Plugin | null, refresh: unknown): PluginInfo | null | undefined {
  const [info, setInfo] = useState<PluginInfo | null | undefined>(undefined);
  useEffect(() => {
    setInfo(undefined);
    if (!plugin) return;
    let alive = true;
    plugin.info().then(
      (i) => alive && setInfo(i),
      () => alive && setInfo(null),
    );
    return () => {
      alive = false;
    };
  }, [plugin, refresh]);
  return info;
}

/** What is on disk and running, from plugin_install.rs (OBS) or streamlabs_plugin.rs. */
export interface PluginFiles {
  /** Null when this build of the app has no plugin bundled for the software. */
  bundledVersion: string | null;
  installed: boolean;
  installedVersion: string | null;
  /** OBS: the plugin from before the rename (obs-audio-kit) is still there; installing removes it. */
  legacyInstalled: boolean;
  /** The streaming software is running (it then holds a loaded plugin file locked). */
  running: boolean;
  /** OBS 32's plugin manager; null when it has no record, and always for Streamlabs. */
  enabledInPluginManager: boolean | null;
}

async function readPluginFiles(software: SoftwareId): Promise<PluginFiles> {
  if (software === "streamlabs") {
    const s = await invoke<{ bundledVersion: string | null; installed: boolean; installedVersion: string | null; streamlabsRunning: boolean }>(
      "streamlabs_plugin_status",
    );
    return { ...s, legacyInstalled: false, running: s.streamlabsRunning, enabledInPluginManager: null };
  }
  const { obsRunning, ...s } = await invoke<Omit<PluginFiles, "running"> & { obsRunning: boolean }>("plugin_status");
  return { ...s, running: obsRunning };
}

/** Polls `software`'s plugin files every `intervalMs`. */
export function usePluginFiles(software: SoftwareId, intervalMs: number): PluginFiles | null {
  const [files, setFiles] = useState<PluginFiles | null>(null);
  useEffect(() => {
    let alive = true;
    setFiles(null);
    const poll = () =>
      readPluginFiles(software)
        .then((f) => alive && setFiles(f))
        .catch(() => {});
    poll();
    const id = setInterval(poll, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [software, intervalMs]);
  return files;
}

/** Compares dotted versions numerically: negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export type PluginNeed = "none" | "install" | "update" | "notLoaded";

export interface PluginAssessment {
  /** What to ask the user to do, if anything. */
  need: PluginNeed;
  /** The installed file is the bundled version or newer. */
  fileCurrent: boolean;
  /** The software has the bundled version (or newer) loaded right now. */
  loadedCurrent: boolean;
}

/**
 * The one place that decides what the plugin situation is. `loadedVersion` is what the plugin
 * reports (null if the software isn't connected or the plugin isn't loaded).
 */
export function assessPlugin(files: PluginFiles, loadedVersion: string | null, connected: boolean): PluginAssessment {
  const bundled = files.bundledVersion;
  const atLeastBundled = (v: string | null) => Boolean(bundled && v && compareVersions(v, bundled) >= 0);
  const fileCurrent = atLeastBundled(files.installedVersion);
  const loadedCurrent = atLeastBundled(loadedVersion);

  let need: PluginNeed;
  if (!bundled) need = "none";
  else if (loadedVersion) need = loadedCurrent ? "none" : "update";
  else if (!files.installed) need = "install";
  else if (files.installedVersion && !fileCurrent) need = "update";
  // Installed and current, but the software runs without it (not restarted yet, or disabled).
  else need = connected ? "notLoaded" : "none";

  return { need, fileCurrent, loadedCurrent };
}

/**
 * Whether the plugin matters for this connection: it is installed on this computer, so it
 * applies while connected to software running here, and while not connected yet to OBS (whose
 * install doesn't need a connection; Streamlabs' does, to load it).
 */
export function pluginApplies(connection: ConnectionState): boolean {
  if (connection.kind === "connected") return connection.local;
  if (connection.kind === "failed") return connection.software === "obs";
  return true;
}
