// Placeholder data and fake meters until the obs-websocket connection exists.
import { useEffect, useRef, useState } from "react";
import type { AudioSource, ChannelLevels, Scene } from "./types";

const voiceChain = [
  { name: "噪音抑制", enabled: true },
  { name: "噪音閘", enabled: true },
  { name: "壓縮器", enabled: true },
  { name: "限制器", enabled: false },
];

export const mockSources: AudioSource[] = [
  { name: "麥克風", device: "Shure MV7", volumeDb: -6, muted: false, monitorType: "OBS_MONITORING_TYPE_NONE", filters: voiceChain, tracks: [1, 2], global: true },
  { name: "桌面音訊", device: "系統輸出", volumeDb: -14, muted: false, monitorType: "OBS_MONITORING_TYPE_NONE", filters: [{ name: "限制器", enabled: true }], tracks: [1], global: true },
  { name: "遊戲音效", device: "應用程式：Elden Ring", volumeDb: -10, muted: false, monitorType: "OBS_MONITORING_TYPE_NONE", filters: [], tracks: [1], global: false },
  { name: "Discord", device: "應用程式：Discord", volumeDb: -9, muted: false, monitorType: "OBS_MONITORING_TYPE_MONITOR_ONLY", filters: [{ name: "壓縮器", enabled: false }], tracks: [1], global: false },
  { name: "斗內通知", device: "瀏覽器來源", volumeDb: -8, muted: false, monitorType: "OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT", filters: [], tracks: [2], global: false },
  { name: "背景音樂", device: "應用程式：Spotify", volumeDb: -24, muted: false, monitorType: "OBS_MONITORING_TYPE_NONE", filters: [], tracks: [1], global: false },
  { name: "開場影片", device: "媒體來源：intro.mp4", volumeDb: -12, muted: false, monitorType: "OBS_MONITORING_TYPE_NONE", filters: [], tracks: [1], global: false },
  { name: "音效板", device: "媒體來源", volumeDb: -10, muted: true, monitorType: "OBS_MONITORING_TYPE_NONE", filters: [], tracks: [1], global: false },
];

export const mockScenes: Scene[] = [
  {
    name: "開場",
    items: [
      { sourceName: "開場影片", enabled: true },
      { sourceName: "背景音樂", enabled: true },
    ],
  },
  {
    name: "遊戲",
    items: [
      { sourceName: "遊戲音效", enabled: true },
      { sourceName: "Discord", enabled: true },
      { sourceName: "通知層", enabled: true, isScene: true },
    ],
  },
  {
    name: "聊天",
    items: [
      { sourceName: "背景音樂", enabled: false },
      { sourceName: "音效板", enabled: true },
      { sourceName: "Discord", enabled: true },
      { sourceName: "通知層", enabled: true, isScene: true },
    ],
  },
  {
    name: "休息",
    items: [{ sourceName: "背景音樂", enabled: true }],
  },
  // A nested scene reused by 遊戲 and 聊天.
  {
    name: "通知層",
    items: [{ sourceName: "斗內通知", enabled: true }],
  },
];

/** Scenes the user switches between; nested helper scenes are left out. */
export const mockSwitchableScenes = ["開場", "遊戲", "聊天", "休息"];

export const mockStreamTracks = [1];

/** How loud each source's raw signal is right now; 0 means it is silent. */
const signal: Record<string, number> = {
  麥克風: 0.45,
  桌面音訊: 0,
  遊戲音效: 0.4,
  Discord: 0,
  斗內通知: 0.3,
  背景音樂: 0.35,
  開場影片: 0.4,
  音效板: 0.3,
};

/** Fake input levels keyed by source name, updated ~30 times per second. */
export function useMockLevels(sources: AudioSource[]): Record<string, ChannelLevels> {
  const [levels, setLevels] = useState<Record<string, ChannelLevels>>({});
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  useEffect(() => {
    const start = performance.now();
    const id = setInterval(() => {
      const t = (performance.now() - start) / 1000;
      const next: Record<string, ChannelLevels> = {};
      sourcesRef.current.forEach((s, i) => {
        const base = signal[s.name] ?? 0;
        const gain = (s.volumeDb + 60) / 60;
        const ch = (k: number) => {
          if (s.muted || base === 0) return 0;
          const w =
            (Math.sin(t * 3.1 + i * 1.3 + k * 0.4) * 0.5 + 0.5) * 0.28 +
            (Math.sin(t * 7.3 + i * 2.6) * 0.5 + 0.5) * 0.12 +
            Math.random() * 0.05;
          return Math.min(1, (base + w) * gain * (k ? 0.94 : 1));
        };
        next[s.name] = [ch(0), ch(1)];
      });
      setLevels(next);
    }, 33);
    return () => clearInterval(id);
  }, []);

  return levels;
}
