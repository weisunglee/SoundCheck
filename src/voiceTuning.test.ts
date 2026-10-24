// The tuned chain lands in the right order around the filters a source already has, can be
// compared against the old one, and undo puts everything back exactly.
import { describe, expect, it } from "vitest";
import type { FilterOps, SourceFilter } from "./adapter";
import { VOICE_ANALYZER_KIND, VOICE_EQ_KIND } from "./plugin";
import { type VoicePlan, addAnalyzer, applyPlan, compare, finish, plannedChain, removeAnalyzers, undo } from "./voiceTuning";

type Stored = Omit<SourceFilter, "index">;

/** Filters of one source, kept in order the way the streaming software does. */
function fakeOps(initial: Stored[]): FilterOps & { chain: Stored[] } {
  const chain = initial.map((f) => ({ ...f, settings: { ...f.settings } }));
  const find = (name: string) => {
    const f = chain.find((x) => x.name === name);
    if (!f) throw new Error(`no filter ${name}`);
    return f;
  };
  return {
    chain,
    list: async () => chain.map((f, index) => ({ ...f, settings: { ...f.settings }, index })),
    create: async (_s, name, kind, settings) => {
      if (chain.some((f) => f.name === name)) throw new Error("taken");
      chain.push({ name, kind, enabled: true, settings: { ...settings } });
    },
    remove: async (_s, name) => {
      chain.splice(chain.indexOf(find(name)), 1);
    },
    move: async (_s, name, index) => {
      const f = find(name);
      chain.splice(chain.indexOf(f), 1);
      chain.splice(Math.min(index, chain.length), 0, f);
    },
    setSettings: async (_s, name, settings, replace) => {
      const f = find(name);
      f.settings = replace ? { ...settings } : { ...f.settings, ...settings };
    },
    setEnabled: async (_s, name, enabled) => {
      find(name).enabled = enabled;
    },
    watch: () => () => {},
  };
}

const plan: VoicePlan = {
  noiseSuppression: true,
  highpassHz: 85,
  mud: { freq: 315, gainDb: -3, q: 1.4 },
  deEsser: null,
  compressor: { thresholdDb: -22, ratio: 3, attackMs: 5, releaseMs: 80, outputGainDb: 8 },
  gainDb: 0,
  presence: { freq: 3150, gainDb: 2.5, q: 1 },
  air: null,
  limiterDb: -2,
};

const kinds = (ops: { chain: Stored[] }) => ops.chain.map((f) => `${f.kind}${f.enabled ? "" : " (off)"}`);

describe("voice tuning chain", () => {
  it("builds fix EQ → compressor → polish EQ → limiter, after noise suppression", async () => {
    const ops = fakeOps([{ name: "Color", kind: "color_filter", enabled: true, settings: {} }]);
    await applyPlan(ops, "Mic", plan);
    // Without audio filters to line up with, the chain goes after the video filters.
    expect(kinds(ops)).toEqual(["color_filter", "noise_suppress_filter_v2", VOICE_EQ_KIND, "compressor_filter", VOICE_EQ_KIND, "limiter_filter"]);
    const [, , fix, comp, polish, limiter] = ops.chain;
    expect(fix.settings).toMatchObject({ hpf_freq: 85, mud_freq: 315, mud_gain: -3, presence_gain: 0, deess_enabled: false });
    expect(comp.settings).toMatchObject({ ratio: 3, threshold: -22, output_gain: 8 });
    expect(polish.settings).toMatchObject({ hpf_freq: 0, mud_gain: 0, presence_freq: 3150, presence_gain: 2.5, air_gain: 0 });
    expect(limiter.settings).toMatchObject({ threshold: -2 });
  });

  it("adds a gain filter only when the compressor's makeup isn't enough, and no polish EQ without lifts", () => {
    const quiet = plannedChain({ ...plan, gainDb: 4, presence: null }).map((f) => f.kind);
    expect(quiet).toEqual([VOICE_EQ_KIND, "compressor_filter", "gain_filter", "limiter_filter"]);
  });

  it("keeps the user's noise filters in front and turns off what it replaces", async () => {
    const ops = fakeOps([
      { name: "Gate", kind: "noise_gate_filter", enabled: true, settings: { open_threshold: -30 } },
      { name: "Old comp", kind: "compressor_filter", enabled: true, settings: { ratio: 10 } },
      { name: "RNNoise", kind: "noise_suppress_filter_v2", enabled: true, settings: { method: "rnnoise" } },
      { name: "VST", kind: "vst_filter", enabled: true, settings: {} },
    ]);
    const applied = await applyPlan(ops, "Mic", plan);
    // The existing noise suppression is kept, so none is added.
    expect(kinds(ops)).toEqual([
      "noise_gate_filter",
      "compressor_filter (off)",
      "noise_suppress_filter_v2",
      VOICE_EQ_KIND,
      "compressor_filter",
      VOICE_EQ_KIND,
      "limiter_filter",
      "vst_filter",
    ]);
    expect(applied.replaced).toEqual(["Old comp"]);

    await compare(ops, "Mic", applied, false);
    expect(ops.chain.filter((f) => f.enabled).map((f) => f.name)).toEqual(["Gate", "Old comp", "RNNoise", "VST"]);
    await compare(ops, "Mic", applied, true);
    await finish(ops, "Mic", applied);
    expect(ops.chain.some((f) => f.name === "Old comp")).toBe(false);
    expect(ops.chain.every((f) => f.enabled)).toBe(true);
  });

  it("undo puts back names, order, settings and on/off, even after finishing", async () => {
    const initial: Stored[] = [
      { name: "Color", kind: "color_filter", enabled: true, settings: {} },
      { name: "EQ", kind: "basic_eq_filter", enabled: true, settings: { low: 3 } },
      { name: "Limiter", kind: "limiter_filter", enabled: false, settings: { threshold: -6 } },
      { name: "Gain", kind: "gain_filter", enabled: true, settings: { db: 5 } },
    ];
    const ops = fakeOps(initial);
    const applied = await applyPlan(ops, "Mic", plan);
    await finish(ops, "Mic", applied);
    await undo(ops, "Mic", applied);
    expect(ops.chain).toEqual(initial);
  });

  it("undoes what it did when the software rejects a step", async () => {
    const initial: Stored[] = [{ name: "Comp", kind: "compressor_filter", enabled: true, settings: { ratio: 4 } }];
    const ops = fakeOps(initial);
    const create = ops.create;
    ops.create = async (s, name, kind, settings) => {
      if (kind === "limiter_filter") throw new Error("no limiter here");
      await create(s, name, kind, settings);
    };
    await expect(applyPlan(ops, "Mic", plan)).rejects.toThrow("no limiter here");
    expect(ops.chain).toEqual(initial);
  });
});

describe("analyzer", () => {
  it("goes first, and leftovers from an earlier run are removed", async () => {
    const ops = fakeOps([
      { name: "Gate", kind: "noise_gate_filter", enabled: true, settings: {} },
      { name: "Old", kind: VOICE_ANALYZER_KIND, enabled: true, settings: {} },
    ]);
    const name = await addAnalyzer(ops, "Mic");
    expect(ops.chain.map((f) => f.name)).toEqual([name, "Gate"]);
    await removeAnalyzers(ops, "Mic");
    expect(ops.chain.map((f) => f.name)).toEqual(["Gate"]);
  });
});
