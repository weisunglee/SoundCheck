// Keeps the plugin's tap of the stream mix connected and exposes its live levels.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import type { Plugin } from "./plugin";

export interface StreamLevel {
  /** Peak per channel since the last update, 0..1. */
  peaks: [number, number];
  shortTermLufs: number | null;
}

const RESTART_MS = 2000;
/** How often to check whether the stream switched to another track in the output settings. */
const TRACK_CHECK_MS = 5000;

/**
 * Runs the tap while `plugin` is set (software on this computer is connected and the plugin is
 * loaded), restarting it if it drops or if the stream starts using a different track.
 */
export function useStreamTap(plugin: Plugin | null): { level: StreamLevel | null; running: boolean } {
  const [level, setLevel] = useState<StreamLevel | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!plugin) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let tappedTrack: number | null = null;
    let starting = false;

    const start = async () => {
      clearTimeout(timer);
      starting = true;
      try {
        const { port, track } = await plugin.startTap();
        if (!alive) return;
        await invoke("stream_tap_start", { port });
        // Cleanup may have run while the start was in flight; don't leave a reader behind.
        if (!alive) {
          invoke("stream_tap_stop").catch(() => {});
          return;
        }
        tappedTrack = track;
        setRunning(true);
      } catch {
        if (alive) timer = setTimeout(start, RESTART_MS);
      } finally {
        starting = false;
      }
    };

    const trackCheck = setInterval(async () => {
      if (tappedTrack === null) return;
      try {
        const now = (await plugin.info()).streamTracks[0];
        if (alive && now !== undefined && now !== tappedTrack) {
          tappedTrack = null;
          start();
        }
      } catch {
        // The tap's own end event handles a lost connection.
      }
    }, TRACK_CHECK_MS);

    const offLevel = listen<StreamLevel>("stream-level", (e) => alive && setLevel(e.payload));
    const offEnded = listen("stream-tap-ended", () => {
      // A restart in progress closes the old connection itself; that end is expected.
      if (!alive || starting) return;
      tappedTrack = null;
      setRunning(false);
      setLevel(null);
      timer = setTimeout(start, RESTART_MS);
    });
    start();

    return () => {
      alive = false;
      clearTimeout(timer);
      clearInterval(trackCheck);
      offLevel.then((off) => off());
      offEnded.then((off) => off());
      invoke("stream_tap_stop").catch(() => {});
      plugin.stopTap().catch(() => {});
      setRunning(false);
      setLevel(null);
    };
  }, [plugin]);

  return { level, running };
}
