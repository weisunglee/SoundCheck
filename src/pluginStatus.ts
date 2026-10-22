// What is installed on disk, what the app bundles, and whether OBS is running.
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

export interface PluginStatus {
  bundledVersion: string | null;
  installed: boolean;
  installedVersion: string | null;
  installPath: string;
  obsRunning: boolean;
  enabledInPluginManager: boolean | null;
}

/** Compares dotted version strings numerically: negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Polls the installer status every `intervalMs`. */
export function usePluginStatus(intervalMs: number): PluginStatus | null {
  const [status, setStatus] = useState<PluginStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = () =>
      invoke<PluginStatus>("plugin_status")
        .then((s) => alive && setStatus(s))
        .catch(() => {});
    poll();
    const id = setInterval(poll, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [intervalMs]);
  return status;
}

export type PluginNeed = "none" | "install" | "update" | "notLoaded";

/**
 * Whether the user needs to do anything about the plugin. `loadedVersion` is what OBS
 * reports (null if OBS isn't connected or the plugin isn't loaded).
 */
export function pluginNeed(status: PluginStatus, loadedVersion: string | null, obsConnected: boolean): PluginNeed {
  const bundled = status.bundledVersion;
  if (!bundled) return "none";
  if (loadedVersion) return compareVersions(loadedVersion, bundled) < 0 ? "update" : "none";
  if (!status.installed) return "install";
  if (status.installedVersion && compareVersions(status.installedVersion, bundled) < 0) return "update";
  // Installed and current, but OBS is running without it (not restarted yet, or disabled).
  return obsConnected ? "notLoaded" : "none";
}
