import type { AudioSource, Scene, SourceStatus } from "./types";

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
