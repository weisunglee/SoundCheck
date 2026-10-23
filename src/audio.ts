// The live audio state of whichever streaming software is connected, through its adapter
// (src/adapter.ts). Loads on connect, applies the changes the adapter reports, reloads after
// structural changes, and updates the UI right away when the user changes something.
import { useEffect, useRef, useState } from "react";
import type { AudioState, SoftwareAdapter } from "./adapter";
import { t } from "./i18n";
import type { AudioSource, ChannelLevels, MonitorType, SceneItem } from "./types";

const RELOAD_DEBOUNCE_MS = 300;

export interface Audio {
  /** Null while nothing is connected. */
  adapter: SoftwareAdapter | null;
  state: AudioState | null;
  levels: Record<string, ChannelLevels>;
  /** Pre-fader input peak per source in dBFS (absent while silent), for filter tuning. */
  inputDb: Record<string, number>;
  error: string | null;
  setVolume(source: string, db: number): void;
  setMuted(source: string, muted: boolean): void;
  setMonitorType(source: string, type: MonitorType): void;
  setBalance(source: string, balance: number): void;
  setSyncOffset(source: string, ms: number): void;
  setFilterEnabled(source: string, filter: string, enabled: boolean): void;
  /** Adds the stream tracks to the source's tracks. */
  addStreamTracks(source: string): void;
  /** Shows or hides scene items (the eye toggle). */
  setItemsVisible(items: { sceneName: string; item: SceneItem }[], visible: boolean): void;
  switchScene(scene: string): void;
}

/** Setters for what the adapter can't do are no-ops; capabilitiesOf() tells the UI to hide them. */
export function useAudio(adapter: SoftwareAdapter | null): Audio {
  const [state, setState] = useState<AudioState | null>(null);
  const [levels, setLevels] = useState<Record<string, ChannelLevels>>({});
  const [inputDb, setInputDb] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const patchSource = (name: string, patch: Partial<AudioSource> | ((s: AudioSource) => Partial<AudioSource>)) =>
    setState(
      (prev) =>
        prev && {
          ...prev,
          sources: prev.sources.map((s) => (s.name === name ? { ...s, ...(typeof patch === "function" ? patch(s) : patch) } : s)),
        },
    );

  useEffect(() => {
    setState(null);
    setLevels({});
    setInputDb({});
    setError(null);
    if (!adapter) return;

    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reload = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        adapter
          .load()
          .then((s) => alive && (setState(s), setError(null)))
          .catch((e: Error) => alive && setError(t("讀取直播軟體狀態失敗：{error}", { error: e.message })));
      }, RELOAD_DEBOUNCE_MS);
    };
    reload();

    const stop = adapter.watch({
      reload,
      patchSource: (name, patch) => alive && patchSource(name, patch),
      patchItem: (sceneName, itemId, enabled) =>
        alive &&
        setState(
          (prev) =>
            prev && {
              ...prev,
              scenes: prev.scenes.map((sc) =>
                sc.name === sceneName ? { ...sc, items: sc.items.map((i) => (i.id === itemId ? { ...i, enabled } : i)) } : sc,
              ),
            },
        ),
      programScene: (programScene) => alive && setState((prev) => prev && { ...prev, programScene }),
      levels: (next, nextInput) => {
        if (!alive) return;
        setLevels(next);
        setInputDb(nextInput);
      },
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      stop();
    };
  }, [adapter]);

  // Each setter updates the UI right away; the adapter's next report confirms or corrects it.
  const send = (p: Promise<unknown>) => p.catch((e: Error) => setError(t("直播軟體沒有接受這個變更：{error}", { error: e.message })));

  return {
    adapter,
    state,
    levels,
    inputDb,
    error,
    setVolume: (name, volumeDb) => {
      if (!adapter) return;
      patchSource(name, { volumeDb });
      send(adapter.setVolume(name, volumeDb));
    },
    setMuted: (name, muted) => {
      if (!adapter) return;
      patchSource(name, { muted });
      send(adapter.setMuted(name, muted));
    },
    setMonitorType: (name, monitorType) => {
      if (!adapter?.setMonitorType) return;
      patchSource(name, { monitorType });
      send(adapter.setMonitorType(name, monitorType));
    },
    setBalance: (name, balance) => {
      if (!adapter?.setBalance) return;
      patchSource(name, { balance });
      send(adapter.setBalance(name, balance));
    },
    setSyncOffset: (name, requested) => {
      if (!adapter?.setSyncOffset) return;
      const [min, max] = adapter.syncOffsetRange ?? [-Infinity, Infinity];
      const syncOffsetMs = Math.max(min, Math.min(max, requested));
      patchSource(name, { syncOffsetMs });
      send(adapter.setSyncOffset(name, syncOffsetMs));
    },
    setFilterEnabled: (name, filter, enabled) => {
      if (!adapter?.filters) return;
      patchSource(name, (s) => ({ filters: s.filters.map((f) => (f.name === filter ? { ...f, enabled } : f)) }));
      send(adapter.filters.setEnabled(name, filter, enabled));
    },
    addStreamTracks: (name) => {
      const current = stateRef.current;
      const source = current?.sources.find((s) => s.name === name);
      if (!adapter?.setTracks || !current || !source) return;
      send(adapter.setTracks(name, [...new Set([...source.tracks, ...current.streamTracks])].sort((a, b) => a - b)));
    },
    setItemsVisible: (items, visible) => {
      if (!adapter) return;
      for (const { sceneName, item } of items) send(adapter.setItemVisible(sceneName, item, visible));
    },
    switchScene: (programScene) => {
      if (!adapter) return;
      setState((prev) => prev && { ...prev, programScene });
      send(adapter.switchScene(programScene));
    },
  };
}
