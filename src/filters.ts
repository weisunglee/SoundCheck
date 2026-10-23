// What each OBS audio filter does, in plain words, and how the filter wizard adds and orders them.
import { obs } from "./obs";

export interface FilterInfo {
  kind: string;
  /** Name given to a filter the wizard creates. */
  label: string;
  /** One sentence on what it does to the sound. */
  what: string;
  /** Where it sits in the chain; lower runs first. */
  order: number;
  /** Settings the wizard creates it with (anything missing keeps OBS's default). */
  initial: Record<string, string | number | boolean>;
}

export const FILTERS: Record<string, FilterInfo> = {
  noise_suppress_filter_v2: {
    kind: "noise_suppress_filter_v2",
    label: "噪音抑制",
    what: "把風扇、冷氣、電腦運轉這類持續的背景噪音壓下去，保留人聲。",
    order: 10,
    initial: { method: "rnnoise" },
  },
  noise_gate_filter: {
    kind: "noise_gate_filter",
    label: "噪音閘",
    what: "你不說話時把麥克風關起來，說話時才打開，擋掉呼吸聲和鍵盤聲。",
    order: 20,
    initial: { open_threshold: -26, close_threshold: -32 },
  },
  expander_filter: {
    kind: "expander_filter",
    label: "擴展器",
    what: "比噪音閘溫和的版本：不說話時把聲音調小，而不是完全關掉。",
    order: 25,
    initial: {},
  },
  basic_eq_filter: {
    kind: "basic_eq_filter",
    label: "三段等化器",
    what: "分別調整低音、中音、高音，例如讓聲音不要太悶或太刺。",
    order: 30,
    initial: {},
  },
  compressor_filter: {
    kind: "compressor_filter",
    label: "壓縮器",
    what: "把太大聲的部分壓小，讓說話音量比較平均，觀眾不用一直調音量。",
    order: 40,
    initial: { ratio: 4, threshold: -18, output_gain: 0 },
  },
  upward_compressor_filter: {
    kind: "upward_compressor_filter",
    label: "向上壓縮器",
    what: "把太小聲的部分拉大，讓小聲說話也聽得清楚。",
    order: 45,
    initial: {},
  },
  gain_filter: {
    kind: "gain_filter",
    label: "增益",
    what: "把整個聲音放大或縮小，適合麥克風本身收音太小的時候。",
    order: 50,
    initial: { db: 0 },
  },
  limiter_filter: {
    kind: "limiter_filter",
    label: "限制器",
    what: "設定一個音量上限，再大聲也不會超過，避免大叫或尖叫時爆音。應該放在最後。",
    order: 60,
    initial: { threshold: -3 },
  },
  vst_filter: {
    kind: "vst_filter",
    label: "VST 外掛",
    what: "第三方的音效外掛，設定要在 OBS 裡開啟它自己的視窗調整。",
    order: 35,
    initial: {},
  },
  invert_polarity_filter: {
    kind: "invert_polarity_filter",
    label: "反轉極性",
    what: "把聲波上下翻轉，只有在兩支麥克風互相抵消、聲音變薄時才需要。",
    order: 5,
    initial: {},
  },
};

export interface Problem {
  id: string;
  title: string;
  detail: string;
  kinds: string[];
}

/** The problems a streamer would describe, and the filters that solve each one. */
export const PROBLEMS: Problem[] = [
  { id: "noise", title: "背景有雜音", detail: "風扇、冷氣、電腦運轉聲", kinds: ["noise_suppress_filter_v2"] },
  { id: "gate", title: "不說話時還有聲音", detail: "呼吸聲、鍵盤滑鼠聲", kinds: ["noise_gate_filter"] },
  { id: "uneven", title: "音量忽大忽小", detail: "觀眾要一直調音量", kinds: ["compressor_filter"] },
  { id: "clip", title: "大叫會爆音", detail: "尖叫、大笑時破音", kinds: ["limiter_filter"] },
  { id: "quiet", title: "整體太小聲", detail: "推桿拉到最大還是小聲", kinds: ["gain_filter"] },
  {
    id: "voice",
    title: "幫我一次設定好人聲",
    detail: "噪音抑制 → 噪音閘 → 壓縮器 → 限制器",
    kinds: ["noise_suppress_filter_v2", "noise_gate_filter", "compressor_filter", "limiter_filter"],
  },
];

export interface SourceFilter {
  name: string;
  kind: string;
  enabled: boolean;
  /** Position among all of the source's filters, including video ones. */
  index: number;
  /** OBS defaults merged with this filter's own settings. */
  settings: Record<string, any>;
}

/** Every filter on a source, with full settings, in chain order. */
export async function loadFilters(sourceName: string): Promise<SourceFilter[]> {
  const { filters } = await obs.call("GetSourceFilterList", { sourceName });
  const list = filters as { filterName: string; filterKind: string; filterEnabled: boolean; filterIndex: number; filterSettings: Record<string, any> }[];
  const kinds = [...new Set(list.map((f) => f.filterKind))];
  const defaults = new Map<string, Record<string, any>>();
  await Promise.all(
    kinds.map((filterKind) =>
      obs
        .call("GetSourceFilterDefaultSettings", { filterKind })
        .then((r) => defaults.set(filterKind, r.defaultFilterSettings as Record<string, any>))
        .catch(() => defaults.set(filterKind, {})),
    ),
  );
  return list
    .map((f) => ({
      name: f.filterName,
      kind: f.filterKind,
      enabled: f.filterEnabled,
      index: f.filterIndex,
      settings: { ...defaults.get(f.filterKind), ...f.filterSettings },
    }))
    .sort((a, b) => a.index - b.index);
}

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

/**
 * Adds a filter of `kind` with the wizard's starting settings and moves it to its place in the
 * recommended chain order. Filters the wizard does not know keep their position.
 */
export async function addFilter(sourceName: string, kind: string): Promise<string> {
  const info = FILTERS[kind];
  const existing = await loadFilters(sourceName);
  const filterName = uniqueName(info.label, new Set(existing.map((f) => f.name)));
  await obs.call("CreateSourceFilter", { sourceName, filterName, filterKind: kind, filterSettings: info.initial });

  // Insert before the first known filter that should run after this one.
  const after = existing.find((f) => FILTERS[f.kind] && FILTERS[f.kind].order > info.order);
  if (after) await obs.call("SetSourceFilterIndex", { sourceName, filterName, filterIndex: after.index });
  return filterName;
}

export async function removeFilter(sourceName: string, filterName: string) {
  await obs.call("RemoveSourceFilter", { sourceName, filterName });
}

export async function moveFilter(sourceName: string, filterName: string, filterIndex: number) {
  await obs.call("SetSourceFilterIndex", { sourceName, filterName, filterIndex });
}

export async function updateFilterSettings(sourceName: string, filterName: string, filterSettings: Record<string, string | number | boolean>) {
  await obs.call("SetSourceFilterSettings", { sourceName, filterName, filterSettings, overlay: true });
}

export async function setFilterEnabled(sourceName: string, filterName: string, filterEnabled: boolean) {
  await obs.call("SetSourceFilterEnabled", { sourceName, filterName, filterEnabled });
}
