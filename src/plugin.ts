// The SoundCheck OBS plugin as the app sees it: the requests it answers (obs-websocket vendor
// "soundcheck", see obs-plugin/src/plugin-main.cpp), what is installed on disk, and what the
// user needs to do about it.
import { invoke } from "@tauri-apps/api/core";
import { OBSWebSocketError } from "obs-websocket-js";
import { useEffect, useState } from "react";
import { t } from "./i18n";
import type { ConnectionState } from "./connection";
import { obs } from "./obsClient";

const VENDOR = "soundcheck";

/** obs-websocket answers 600 "No vendor was found by that name." when the plugin isn't loaded. */
const NO_VENDOR = 600;

async function request<T>(requestType: string, requestData: { [key: string]: string | number | boolean } = {}): Promise<T> {
  try {
    const { responseData } = await obs.call("CallVendorRequest", { vendorName: VENDOR, requestType, requestData });
    const data = responseData as { ok?: boolean; error?: string };
    if (data.ok === false) throw new Error(data.error ?? t("外掛回報失敗"));
    return data as T;
  } catch (e) {
    if (e instanceof OBSWebSocketError && e.code === NO_VENDOR && /vendor/i.test(e.message)) {
      throw new Error(t("直播軟體裡沒有安裝 SoundCheck 外掛，試音需要它。"));
    }
    throw e;
  }
}

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

/** The plugin's requests. Every call rejects with a readable error if the plugin isn't loaded. */
export const plugin = {
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
};

/**
 * What the plugin reports once `active` (connected to OBS) turns true: null when it isn't
 * loaded, undefined until it has answered or while inactive. OBS only loads plugins at startup,
 * so one answer lasts for the whole connection.
 */
export function usePluginInfo(active: boolean): PluginInfo | null | undefined {
  const [info, setInfo] = useState<PluginInfo | null | undefined>(undefined);
  useEffect(() => {
    setInfo(undefined);
    if (!active) return;
    let alive = true;
    plugin.info().then(
      (i) => alive && setInfo(i),
      () => alive && setInfo(null),
    );
    return () => {
      alive = false;
    };
  }, [active]);
  return info;
}

/** What is on disk and running, from plugin_install.rs. */
export interface PluginFiles {
  /** Null when this build of the app has no plugin bundled. */
  bundledVersion: string | null;
  installed: boolean;
  installedVersion: string | null;
  /** The plugin from before the rename (obs-audio-kit) is still there; installing removes it. */
  legacyInstalled: boolean;
  obsRunning: boolean;
  enabledInPluginManager: boolean | null;
}

/** Polls the plugin files every `intervalMs`. */
export function usePluginFiles(intervalMs: number): PluginFiles | null {
  const [files, setFiles] = useState<PluginFiles | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = () =>
      invoke<PluginFiles>("plugin_status")
        .then((f) => alive && setFiles(f))
        .catch(() => {});
    poll();
    const id = setInterval(poll, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [intervalMs]);
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
  /** OBS has the bundled version (or newer) loaded right now. */
  loadedCurrent: boolean;
}

/**
 * The one place that decides what the plugin situation is. `loadedVersion` is what OBS reports
 * (null if OBS isn't connected or the plugin isn't loaded).
 */
export function assessPlugin(files: PluginFiles, loadedVersion: string | null, obsConnected: boolean): PluginAssessment {
  const bundled = files.bundledVersion;
  const atLeastBundled = (v: string | null) => Boolean(bundled && v && compareVersions(v, bundled) >= 0);
  const fileCurrent = atLeastBundled(files.installedVersion);
  const loadedCurrent = atLeastBundled(loadedVersion);

  let need: PluginNeed;
  if (!bundled) need = "none";
  else if (loadedVersion) need = loadedCurrent ? "none" : "update";
  else if (!files.installed) need = "install";
  else if (files.installedVersion && !fileCurrent) need = "update";
  // Installed and current, but OBS is running without it (not restarted yet, or disabled).
  else need = obsConnected ? "notLoaded" : "none";

  return { need, fileCurrent, loadedCurrent };
}

/**
 * Whether the plugin matters for this connection: it is for OBS on this computer, so it applies
 * while connected to local OBS, and while not connected yet unless the attempt was Streamlabs.
 */
export function pluginApplies(connection: ConnectionState): boolean {
  if (connection.kind === "connected") return connection.software === "obs" && connection.local;
  if (connection.kind === "failed") return connection.software === "obs";
  return true;
}
