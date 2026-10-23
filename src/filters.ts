// What each audio filter does, in plain words, and how the filter wizard adds and orders them.
// The filters themselves are reached through the adapter's FilterOps (src/adapter.ts).
import type { FilterOps } from "./adapter";
import { msg, t } from "./i18n";
import { uniqueName } from "./names";

export interface FilterInfo {
  kind: string;
  /** Name given to a filter the wizard creates. */
  label: string;
  /** One sentence on what it does to the sound. */
  what: string;
  /** Where it sits in the chain; lower runs first. */
  order: number;
  /** Settings the wizard creates it with (anything missing keeps the software's default). */
  initial: Record<string, string | number | boolean>;
}

export const FILTERS: Record<string, FilterInfo> = {
  noise_suppress_filter_v2: {
    kind: "noise_suppress_filter_v2",
    label: msg("噪音抑制"),
    what: msg("把風扇、冷氣、電腦運轉這類持續的背景噪音壓下去，保留人聲。"),
    order: 10,
    initial: { method: "rnnoise" },
  },
  noise_gate_filter: {
    kind: "noise_gate_filter",
    label: msg("噪音閘"),
    what: msg("你不說話時把麥克風關起來，說話時才打開，擋掉呼吸聲和鍵盤聲。"),
    order: 20,
    initial: { open_threshold: -26, close_threshold: -32 },
  },
  expander_filter: {
    kind: "expander_filter",
    label: msg("擴展器"),
    what: msg("比噪音閘溫和的版本：不說話時把聲音調小，而不是完全關掉。"),
    order: 25,
    initial: {},
  },
  basic_eq_filter: {
    kind: "basic_eq_filter",
    label: msg("三段等化器"),
    what: msg("分別調整低音、中音、高音，例如讓聲音不要太悶或太刺。"),
    order: 30,
    initial: {},
  },
  compressor_filter: {
    kind: "compressor_filter",
    label: msg("壓縮器"),
    what: msg("把太大聲的部分壓小，讓說話音量比較平均，觀眾不用一直調音量。"),
    order: 40,
    initial: { ratio: 4, threshold: -18, output_gain: 0 },
  },
  upward_compressor_filter: {
    kind: "upward_compressor_filter",
    label: msg("向上壓縮器"),
    what: msg("把太小聲的部分拉大，讓小聲說話也聽得清楚。"),
    order: 45,
    initial: {},
  },
  gain_filter: {
    kind: "gain_filter",
    label: msg("增益"),
    what: msg("把整個聲音放大或縮小，適合麥克風本身收音太小的時候。"),
    order: 50,
    initial: { db: 0 },
  },
  limiter_filter: {
    kind: "limiter_filter",
    label: msg("限制器"),
    what: msg("設定一個音量上限，再大聲也不會超過，避免大叫或尖叫時爆音。應該放在最後。"),
    order: 60,
    initial: { threshold: -3 },
  },
  vst_filter: {
    kind: "vst_filter",
    label: msg("VST 外掛"),
    what: msg("第三方的音效外掛，設定要在直播軟體裡開啟它自己的視窗調整。"),
    order: 35,
    initial: {},
  },
  invert_polarity_filter: {
    kind: "invert_polarity_filter",
    label: msg("反轉極性"),
    what: msg("把聲波上下翻轉，只有在兩支麥克風互相抵消、聲音變薄時才需要。"),
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
  { id: "noise", title: msg("背景有雜音"), detail: msg("風扇、冷氣、電腦運轉聲"), kinds: ["noise_suppress_filter_v2"] },
  { id: "gate", title: msg("不說話時還有聲音"), detail: msg("呼吸聲、鍵盤滑鼠聲"), kinds: ["noise_gate_filter"] },
  { id: "uneven", title: msg("音量忽大忽小"), detail: msg("觀眾要一直調音量"), kinds: ["compressor_filter"] },
  { id: "clip", title: msg("大叫會爆音"), detail: msg("尖叫、大笑時破音"), kinds: ["limiter_filter"] },
  { id: "quiet", title: msg("整體太小聲"), detail: msg("推桿拉到最大還是小聲"), kinds: ["gain_filter"] },
  {
    id: "voice",
    title: msg("幫我一次設定好人聲"),
    detail: msg("噪音抑制 → 噪音閘 → 壓縮器 → 限制器"),
    kinds: ["noise_suppress_filter_v2", "noise_gate_filter", "compressor_filter", "limiter_filter"],
  },
];

/**
 * Adds a filter of `kind` with the wizard's starting settings and moves it to its place in the
 * recommended chain order. Filters the wizard does not know keep their position.
 */
export async function addFilter(ops: FilterOps, sourceName: string, kind: string): Promise<string> {
  const info = FILTERS[kind];
  const existing = await ops.list(sourceName);
  // The filter is named in the UI language, since that is the name the user then sees in the software.
  const filterName = uniqueName(t(info.label), existing.map((f) => f.name));
  await ops.create(sourceName, filterName, kind, info.initial);

  // Insert before the first known filter that should run after this one.
  const after = existing.find((f) => FILTERS[f.kind] && FILTERS[f.kind].order > info.order);
  if (after) await ops.move(sourceName, filterName, after.index);
  return filterName;
}
