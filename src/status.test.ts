import { describe, expect, it } from "vitest";
import { itemsToShow, presenceInScene, scenesContaining, sourceStatus } from "./status";
import type { AudioSource, Scene } from "./types";

const source = (name: string, patch: Partial<AudioSource> = {}): AudioSource => ({
  name,
  device: "",
  inputKind: "",
  volumeDb: 0,
  muted: false,
  balance: 0.5,
  syncOffsetMs: 0,
  monitorType: "off",
  filters: [],
  tracks: [1],
  global: false,
  ...patch,
});

// Game contains Mic and a nested "Overlay" scene holding Alerts; Chat hides Music.
const scenes: Scene[] = [
  {
    name: "Game",
    items: [
      { id: 1, sourceName: "Mic", enabled: true },
      { id: 2, sourceName: "Overlay", enabled: true, isScene: true },
    ],
  },
  { name: "Chat", items: [{ id: 1, sourceName: "Music", enabled: false }] },
  { name: "Overlay", items: [{ id: 7, sourceName: "Alerts", enabled: true }] },
];

describe("presenceInScene", () => {
  it("finds sources in nested scenes", () => {
    expect(presenceInScene("Game", "Alerts", scenes)).toBe("visible");
  });
  it("reports hidden items and absent sources", () => {
    expect(presenceInScene("Chat", "Music", scenes)).toBe("hidden");
    expect(presenceInScene("Chat", "Mic", scenes)).toBe("absent");
  });
  it("treats everything under a hidden nested scene as hidden", () => {
    const hiddenOverlay: Scene[] = [{ ...scenes[0], items: [{ id: 2, sourceName: "Overlay", enabled: false, isScene: true }] }, scenes[2]];
    expect(presenceInScene("Game", "Alerts", hiddenOverlay)).toBe("hidden");
  });
  it("does not loop on scenes that contain each other", () => {
    const loop: Scene[] = [
      { name: "A", items: [{ id: 1, sourceName: "B", enabled: true, isScene: true }] },
      { name: "B", items: [{ id: 1, sourceName: "A", enabled: true, isScene: true }] },
    ];
    expect(presenceInScene("A", "Mic", loop)).toBe("absent");
  });
});

describe("sourceStatus", () => {
  const status = (s: AudioSource, scene = "Game") => sourceStatus(s, scene, scenes, [1]);

  it("is live when visible, unmuted, output on and on a stream track", () => {
    expect(status(source("Mic"))).toBe("live");
  });
  it("checks presence before mute, monitoring and tracks", () => {
    expect(status(source("Music", { muted: true }), "Chat")).toBe("hidden");
    expect(status(source("Nowhere", { muted: true }))).toBe("notInScene");
  });
  it("reports mute, monitor-only and off-stream in that order", () => {
    expect(status(source("Mic", { muted: true, monitorType: "monitorOnly" }))).toBe("muted");
    expect(status(source("Mic", { monitorType: "monitorOnly", tracks: [2] }))).toBe("monitorOnly");
    expect(status(source("Mic", { tracks: [2] }))).toBe("offStream");
  });
  it("counts global devices as present in every scene", () => {
    expect(status(source("Desktop", { global: true }), "Chat")).toBe("live");
  });
});

describe("scenesContaining", () => {
  it("lists every scene that holds the source, including through nesting", () => {
    expect(scenesContaining(source("Alerts"), scenes)).toEqual(["Game", "Overlay"]);
    expect(scenesContaining(source("Desktop", { global: true }), scenes)).toEqual(["Game", "Chat", "Overlay"]);
  });
});

describe("itemsToShow", () => {
  it("returns the hidden item and any hidden nested scene on the way", () => {
    const hidden: Scene[] = [
      { name: "Game", items: [{ id: 2, sourceName: "Overlay", enabled: false, isScene: true }] },
      { name: "Overlay", items: [{ id: 7, sourceName: "Alerts", enabled: false }] },
    ];
    const toShow = itemsToShow("Game", "Alerts", hidden).map((x) => `${x.sceneName}/${x.item.id}`);
    expect(toShow.sort()).toEqual(["Game/2", "Overlay/7"]);
  });
  it("returns nothing when the source is already visible", () => {
    expect(itemsToShow("Game", "Mic", scenes)).toEqual([]);
  });
});
