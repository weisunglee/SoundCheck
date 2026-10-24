// Voice tuning: record the mic before its filters (the plugin's analyzer filter), let the backend
// analyze it (src-tauri/src/voice_analysis.rs), and turn the result into a filter chain:
//
//   noise suppression → noise gate (if the user has one) → voice EQ "fix" (high-pass, mud cut,
//   de-esser) → compressor → gain → voice EQ "polish" (presence, air) → limiter
//
// The fix EQ runs before the compressor so the compressor doesn't work on rumble or the mud the
// EQ takes out, and the de-esser with it because its threshold is measured on the recording,
// which is the level it sees there. Lifts (presence, air) come after the compressor so it
// doesn't push back on what they add. Everything goes through FilterOps, so any adapter whose
// plugin has the voice filters can use it.
import type { FilterOps, SourceFilter } from "./adapter";
import { FILTERS } from "./filters";
import { msg, t } from "./i18n";
import { uniqueName } from "./names";
import { VOICE_ANALYZER_KIND, VOICE_EQ_KIND } from "./plugin";

export type IssueKind = "silent" | "tooShort" | "tooQuiet" | "clipping" | "nearClipping" | "tooNoisy" | "someNoise";

export interface Band {
  freq: number;
  gainDb: number;
  q: number;
}

export interface VoicePlan {
  noiseSuppression: boolean;
  highpassHz: number;
  mud: Band | null;
  deEsser: { freq: number; thresholdDb: number; maxReductionDb: number } | null;
  compressor: { thresholdDb: number; ratio: number; attackMs: number; releaseMs: number; outputGainDb: number };
  gainDb: number;
  presence: Band | null;
  air: Band | null;
  limiterDb: number;
}

/** What voice_analyze returns. */
export interface VoiceAnalysis {
  durationSec: number;
  voicedSec: number;
  peakDbfs: number | null;
  clippedSamples: number;
  speechDbfs: number | null;
  noiseDbfs: number | null;
  loudnessLufs: number | null;
  pitchHz: number | null;
  pitchLowHz: number | null;
  bands: { freq: number; deviationDb: number }[];
  issues: { kind: IssueKind; blocking: boolean }[];
  plan: VoicePlan | null;
}

/** Loudness the plan aims at (TARGET_LUFS in voice_analysis.rs). */
export const TARGET_LUFS = -16;

const ANALYZER_NAME = msg("SoundCheck 錄音分析");
const FIX_NAME = msg("人聲 EQ（修正）");
const POLISH_NAME = msg("人聲 EQ（潤飾）");

/** Filters the tuning replaces: it sets up its own EQ and dynamics, so the old ones are turned off. */
const REPLACED_KINDS = new Set(["basic_eq_filter", "compressor_filter", "upward_compressor_filter", "gain_filter", "limiter_filter", VOICE_EQ_KIND]);
/** Filters that stay in front of the tuned chain. */
const FRONT_KINDS = new Set(["invert_polarity_filter", "noise_suppress_filter", "noise_suppress_filter_v2", "noise_gate_filter", "expander_filter"]);
export const isNoiseSuppression = (kind: string) => kind === "noise_suppress_filter" || kind === "noise_suppress_filter_v2";

/** Puts a fresh analyzer first in the chain (removing any left over) and returns its name. */
export async function addAnalyzer(ops: FilterOps, source: string): Promise<string> {
  await removeAnalyzers(ops, source);
  const existing = await ops.list(source);
  const name = uniqueName(t(ANALYZER_NAME), existing.map((f) => f.name));
  await ops.create(source, name, VOICE_ANALYZER_KIND, {});
  await ops.move(source, name, 0);
  return name;
}

/** Removes every analyzer from the source, including ones an earlier run left behind. */
export async function removeAnalyzers(ops: FilterOps, source: string): Promise<void> {
  for (const f of await ops.list(source)) if (f.kind === VOICE_ANALYZER_KIND) await ops.remove(source, f.name);
}

interface PlannedFilter {
  label: string;
  kind: string;
  settings: Record<string, number | boolean | string>;
}

/** The filters the plan adds after the ones kept in front, in chain order. */
export function plannedChain(plan: VoicePlan): PlannedFilter[] {
  const chain: PlannedFilter[] = [];
  chain.push({
    label: FIX_NAME,
    kind: VOICE_EQ_KIND,
    settings: {
      hpf_freq: plan.highpassHz,
      mud_freq: plan.mud?.freq ?? 300,
      mud_gain: plan.mud?.gainDb ?? 0,
      mud_q: plan.mud?.q ?? 1.4,
      deess_enabled: Boolean(plan.deEsser),
      deess_freq: plan.deEsser?.freq ?? 6500,
      deess_threshold: plan.deEsser?.thresholdDb ?? -30,
      deess_max_reduction: plan.deEsser?.maxReductionDb ?? 6,
      presence_gain: 0,
      air_gain: 0,
    },
  });
  const c = plan.compressor;
  chain.push({
    label: FILTERS.compressor_filter.label,
    kind: "compressor_filter",
    settings: { ratio: c.ratio, threshold: c.thresholdDb, attack_time: c.attackMs, release_time: c.releaseMs, output_gain: c.outputGainDb },
  });
  if (plan.gainDb !== 0) chain.push({ label: FILTERS.gain_filter.label, kind: "gain_filter", settings: { db: plan.gainDb } });
  if (plan.presence || plan.air) {
    chain.push({
      label: POLISH_NAME,
      kind: VOICE_EQ_KIND,
      settings: {
        hpf_freq: 0,
        mud_gain: 0,
        deess_enabled: false,
        presence_freq: plan.presence?.freq ?? 3000,
        presence_gain: plan.presence?.gainDb ?? 0,
        presence_q: plan.presence?.q ?? 1,
        air_freq: plan.air?.freq ?? 10000,
        air_gain: plan.air?.gainDb ?? 0,
      },
    });
  }
  chain.push({ label: FILTERS.limiter_filter.label, kind: "limiter_filter", settings: { threshold: plan.limiterDb, release_time: 60 } });
  return chain;
}

/** What applying changed, to compare against and to undo. */
export interface Applied {
  /** The source's audio filters before, in chain order. */
  backup: SourceFilter[];
  /** Filters the tuning created. */
  created: string[];
  /** Filters it turned off because the tuned chain replaces them. */
  replaced: string[];
}

/**
 * Sets up the planned chain on `source`. Filters it replaces are turned off, not removed, so the
 * two can be compared; `finish` removes them and `undo` puts everything back.
 */
export async function applyPlan(ops: FilterOps, source: string, plan: VoicePlan): Promise<Applied> {
  const before = await ops.list(source);
  const audio = before.filter((f) => FILTERS[f.kind]);
  const applied: Applied = { backup: audio, created: [], replaced: [] };
  const names = before.map((f) => f.name);
  const create = async (label: string, kind: string, settings: PlannedFilter["settings"]) => {
    const name = uniqueName(t(label), names);
    names.push(name);
    await ops.create(source, name, kind, settings);
    applied.created.push(name);
    return name;
  };

  try {
    for (const f of audio) {
      if (REPLACED_KINDS.has(f.kind) && f.enabled) {
        await ops.setEnabled(source, f.name, false);
        applied.replaced.push(f.name);
      }
    }

    const front = audio.filter((f) => FRONT_KINDS.has(f.kind));
    let suppressor: string | null = null;
    if (plan.noiseSuppression && !front.some((f) => isNoiseSuppression(f.kind) && f.enabled)) {
      const info = FILTERS.noise_suppress_filter_v2;
      suppressor = await create(info.label, info.kind, info.initial);
    }
    const chain: string[] = [];
    for (const p of plannedChain(plan)) chain.push(await create(p.label, p.kind, p.settings));

    // The new noise suppression goes first among the audio filters; the rest right after the
    // filters kept in front, or first when there are none.
    const top = audio.length > 0 ? audio[0].index : before.length;
    let at = front.length > 0 ? Math.max(...front.map((f) => f.index)) + 1 : top;
    if (suppressor) {
      await ops.move(source, suppressor, top);
      at++;
    }
    for (const name of chain) await ops.move(source, name, at++);
  } catch (e) {
    await undo(ops, source, applied).catch(() => {});
    throw e;
  }
  return applied;
}

/** Switches between the tuned chain (`tuned`) and what the source had before. */
export async function compare(ops: FilterOps, source: string, applied: Applied, tuned: boolean): Promise<void> {
  for (const name of applied.created) await ops.setEnabled(source, name, tuned);
  for (const name of applied.replaced) await ops.setEnabled(source, name, !tuned);
}

/** Keeps the tuned chain: makes sure it is on, and removes the filters it replaced. */
export async function finish(ops: FilterOps, source: string, applied: Applied): Promise<void> {
  for (const name of applied.created) await ops.setEnabled(source, name, true);
  for (const name of applied.replaced) await ops.remove(source, name);
}

/** Removes what the tuning added and puts the source's filters back as they were. */
export async function undo(ops: FilterOps, source: string, applied: Applied): Promise<void> {
  const created = new Set(applied.created);
  for (const f of await ops.list(source)) if (created.has(f.name)) await ops.remove(source, f.name);
  const have = new Set((await ops.list(source)).map((f) => f.name));
  for (const f of applied.backup) {
    if (have.has(f.name)) await ops.setSettings(source, f.name, f.settings, true);
    else await ops.create(source, f.name, f.kind, f.settings);
    await ops.setEnabled(source, f.name, f.enabled);
  }
  for (const f of applied.backup) await ops.move(source, f.name, f.index);
}

const hz = (v: number) => (v >= 1000 ? `${+(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`);
const db = (v: number) => `${v > 0 ? "+" : ""}${+v.toFixed(1)} dB`;

/** What is wrong with the recording, in plain words. */
export function issueText(kind: IssueKind): string {
  switch (kind) {
    case "silent":
      return t("沒有收到聲音。請確認麥克風沒有靜音、在直播軟體裡選的是對的裝置。");
    case "tooShort":
      return t("說話的時間太短，分析不出來。錄音時請一直說話，像平常直播那樣。");
    case "tooQuiet":
      return t("麥克風收音太小聲。請把系統音效設定或麥克風本身的輸入音量調大，再錄一次。");
    case "clipping":
      return t("錄音有爆音。請把系統音效設定或麥克風本身的輸入音量調小一點，再錄一次。");
    case "nearClipping":
      return t("最大聲的地方很接近爆音，可以把麥克風的輸入音量調小一點。");
    case "tooNoisy":
      return t("背景噪音太大，聽不清楚人聲。請關掉風扇或冷氣、讓麥克風靠近嘴巴，再錄一次。");
    case "someNoise":
      return t("背景有一點噪音，會加上噪音抑制。");
  }
}

/** What the plan changes and why, one sentence each, in plain words. */
export function describePlan(analysis: VoiceAnalysis, plan: VoicePlan, hasNoiseSuppression: boolean): string[] {
  const lines: string[] = [];
  if (plan.noiseSuppression && !hasNoiseSuppression) lines.push(t("背景有一點噪音，加上噪音抑制把它壓下去。"));
  lines.push(
    analysis.pitchLowHz
      ? t("切掉 {hz} 以下的低頻轟轟聲（冷氣、桌子震動、噴麥）。你的聲音最低大約在 {low}，這樣切不會傷到聲音。", {
          hz: hz(plan.highpassHz),
          low: hz(analysis.pitchLowHz),
        })
      : t("切掉 {hz} 以下的低頻轟轟聲（冷氣、桌子震動、噴麥）。", { hz: hz(plan.highpassHz) }),
  );
  if (plan.mud) lines.push(t("聲音有點悶，減少 {hz} 附近 {db}。", { hz: hz(plan.mud.freq), db: db(plan.mud.gainDb) }));
  if (plan.deEsser) lines.push(t("「ㄙ」「ㄘ」這類齒音比較刺耳，加上齒音消除，只在齒音出現時壓低 {hz} 附近。", { hz: hz(plan.deEsser.freq) }));
  if (plan.presence) lines.push(t("聲音不夠清楚，加強 {hz} 附近 {db}，讓字聽得更清楚。", { hz: hz(plan.presence.freq), db: db(plan.presence.gainDb) }));
  if (plan.air) lines.push(t("高音有點少，加一點空氣感（{hz} 以上 {db}）。", { hz: hz(plan.air.freq), db: db(plan.air.gainDb) }));
  if (!plan.mud && !plan.presence && !plan.air && !plan.deEsser) lines.push(t("你的聲音頻率很平均，不需要再調等化。"));
  lines.push(t("加上壓縮器（{ratio}:1），讓說話音量比較平均。", { ratio: plan.compressor.ratio }));
  const gain = plan.compressor.outputGainDb + plan.gainDb;
  lines.push(
    analysis.loudnessLufs !== null
      ? t("整體音量從大約 {now} LUFS 調到 {target} LUFS（{db}）。", { now: Math.round(analysis.loudnessLufs), target: TARGET_LUFS, db: db(gain) })
      : t("整體音量調到大約 {target} LUFS。", { target: TARGET_LUFS }),
  );
  lines.push(t("最後加上限制器，大叫的時候也不會爆音。"));
  return lines;
}
