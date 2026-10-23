// Whether viewers can hear each audio source (CONTEXT.md: source status), and how the mixer
// groups the sources of the program scene by it.
import type { AudioState } from "./adapter";
import type { AudioSource, ChannelLevels, Scene, SceneItem, SourceStatus } from "./types";

type Presence = "absent" | "hidden" | "visible";

/**
 * Whether `sourceName` appears in `sceneName`, following nested scenes and groups.
 * An item only counts as visible when it and every scene containing it are enabled.
 */
export function presenceInScene(sceneName: string, sourceName: string, scenes: Scene[]): Presence {
  const byName = new Map(scenes.map((s) => [s.name, s]));
  let result: Presence = "absent";

  const walk = (name: string, parentVisible: boolean, seen: Set<string>) => {
    const scene = byName.get(name);
    if (!scene || seen.has(name)) return;
    seen.add(name);
    for (const item of scene.items) {
      const visible = parentVisible && item.enabled;
      if (item.sourceName === sourceName) {
        if (visible) result = "visible";
        else if (result === "absent") result = "hidden";
      }
      if (item.isScene) walk(item.sourceName, visible, seen);
    }
  };

  walk(sceneName, true, new Set());
  return result;
}

export function sourceStatus(
  source: AudioSource,
  programScene: string,
  scenes: Scene[],
  streamTracks: number[],
): SourceStatus {
  const presence = source.global ? "visible" : presenceInScene(programScene, source.name, scenes);
  if (presence === "absent") return "notInScene";
  if (presence === "hidden") return "hidden";
  if (source.muted) return "muted";
  // OBS's "Monitor Only (mute output)" sends the source to the headphones only.
  if (source.monitorType === "monitorOnly") return "monitorOnly";
  if (!source.tracks.some((t) => streamTracks.includes(t))) return "offStream";
  return "live";
}

/** Names of the scenes that contain the source anywhere (visible or hidden). */
export function scenesContaining(source: AudioSource, scenes: Scene[]): string[] {
  if (source.global) return scenes.map((s) => s.name);
  return scenes
    .filter((s) => presenceInScene(s.name, source.name, scenes) !== "absent")
    .map((s) => s.name);
}

/**
 * The hidden scene items to enable so `sourceName` becomes visible in `sceneName`:
 * the source's own items plus any hidden nested scene or group on the way to them.
 */
export function itemsToShow(sceneName: string, sourceName: string, scenes: Scene[]): { sceneName: string; item: SceneItem }[] {
  const byName = new Map(scenes.map((s) => [s.name, s]));
  const found = new Map<string, { sceneName: string; item: SceneItem }>();

  const walk = (name: string, path: { sceneName: string; item: SceneItem }[], seen: Set<string>) => {
    const scene = byName.get(name);
    if (!scene || seen.has(name)) return;
    const next = new Set(seen).add(name);
    for (const item of scene.items) {
      const here = [...path, { sceneName: name, item }];
      if (item.sourceName === sourceName) {
        for (const step of here) if (!step.item.enabled) found.set(`${step.sceneName}/${step.item.id}`, step);
      }
      if (item.isScene) walk(item.sourceName, here, next);
    }
  };

  walk(sceneName, [], new Set());
  return [...found.values()];
}

/**
 * The scene items to disable so `sourceName` is hidden in `sceneName`: its own items that are
 * visible there. Nested scenes and groups on the way stay as they are, since they hold other
 * sources too.
 */
export function itemsToHide(sceneName: string, sourceName: string, scenes: Scene[]): { sceneName: string; item: SceneItem }[] {
  const byName = new Map(scenes.map((s) => [s.name, s]));
  const found = new Map<string, { sceneName: string; item: SceneItem }>();

  const walk = (name: string, seen: Set<string>) => {
    const scene = byName.get(name);
    if (!scene || seen.has(name)) return;
    const next = new Set(seen).add(name);
    for (const item of scene.items) {
      if (!item.enabled) continue;
      if (item.sourceName === sourceName) found.set(`${name}/${item.id}`, { sceneName: name, item });
      if (item.isScene) walk(item.sourceName, next);
    }
  };

  walk(sceneName, new Set());
  return [...found.values()];
}

/** A meter position above this (about -57 dBFS) counts as "making sound". */
const SOUND_THRESHOLD = 0.05;
/** Keep counting a source as making sound this long after its last loud moment, so pauses in speech don't flicker. */
const SOUND_HOLD_MS = 1500;

/** Remembers when each source last made sound. */
export class SoundHold {
  private last = new Map<string, number>();

  /**
   * Records `levels` measured at `now` (ms) and returns whether a source counts as making sound.
   * Without meters silence can't be told apart, so every source does.
   */
  observe(levels: Record<string, ChannelLevels>, meters: boolean, now: number): (name: string) => boolean {
    for (const [name, [l, r]] of Object.entries(levels)) {
      if (Math.max(l, r) > SOUND_THRESHOLD) this.last.set(name, now);
    }
    return (name) => !meters || now - (this.last.get(name) ?? -Infinity) < SOUND_HOLD_MS;
  }
}

export interface SourceWithStatus {
  source: AudioSource;
  status: SourceStatus;
}

export interface ProgramAudibility {
  /**
   * The program scene's sources in a fixed order (global devices first, then the software's own
   * order), so a card never moves when its status changes and a mute can be undone in place.
   */
  inScene: SourceWithStatus[];
  /** In `inScene` and heard by viewers. */
  heard: SourceWithStatus[];
  /** Heard, but no sound is coming in right now. */
  silent: SourceWithStatus[];
  /** In the scene, but viewers can't hear them. */
  notHeard: SourceWithStatus[];
  /** Not in the program scene at all. */
  elsewhere: SourceWithStatus[];
  /** How many sources viewers would hear in each switchable scene. */
  heardCount: Record<string, number>;
}

export function programAudibility(state: AudioState, sounding: (name: string) => boolean): ProgramAudibility {
  const { sources, scenes, sceneOrder, programScene, streamTracks } = state;
  const withStatus = sources.map((source) => ({ source, status: sourceStatus(source, programScene, scenes, streamTracks) }));
  const present = withStatus.filter((x) => x.status !== "notInScene");
  const inScene = [...present.filter((x) => x.source.global), ...present.filter((x) => !x.source.global)];
  const heard = inScene.filter((x) => x.status === "live");
  return {
    inScene,
    heard,
    silent: heard.filter((x) => !sounding(x.source.name)),
    notHeard: inScene.filter((x) => x.status !== "live"),
    elsewhere: withStatus.filter((x) => x.status === "notInScene"),
    heardCount: Object.fromEntries(
      sceneOrder.map((scene) => [scene, sources.filter((s) => sourceStatus(s, scene, scenes, streamTracks) === "live").length]),
    ),
  };
}
