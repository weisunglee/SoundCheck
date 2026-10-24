// Profiles save every audio filter as it is and applying one puts the chain back exactly: kinds,
// names, order, on/off and every setting, with audio filters the profile lacks removed.
import { describe, expect, it } from "vitest";
import type { FilterOps, SoftwareAdapter } from "./adapter";
import { applyProfile, captureProfile } from "./profiles";
import type { AudioSource } from "./types";

interface Stored {
  name: string;
  kind: string;
  enabled: boolean;
  settings: Record<string, any>;
}

const SOURCE = "Mic";

/** An adapter over one source's filter chain in memory; `rename` is left out like Streamlabs does. */
function fakeAdapter(chain: Stored[], { rename = true, failKinds = [] as string[] } = {}) {
  const find = (name: string) => {
    const f = chain.find((x) => x.name === name);
    if (!f) throw new Error(`no filter ${name}`);
    return f;
  };
  const filters: FilterOps = {
    list: async () => chain.map((f, index) => ({ ...f, settings: { ...f.settings }, index })),
    async create(_source, name, kind, settings) {
      if (chain.some((f) => f.name === name)) throw new Error(`duplicate ${name}`);
      if (failKinds.includes(kind)) throw new Error(`unknown kind ${kind}`);
      chain.push({ name, kind, enabled: true, settings: { ...settings } });
    },
    async remove(_source, name) {
      chain.splice(chain.indexOf(find(name)), 1);
    },
    async move(_source, name, index) {
      const f = find(name);
      chain.splice(chain.indexOf(f), 1);
      chain.splice(index, 0, f);
    },
    async setSettings(_source, name, settings, replace = false) {
      const f = find(name);
      f.settings = replace ? { ...settings } : { ...f.settings, ...settings };
    },
    async setEnabled(_source, name, enabled) {
      find(name).enabled = enabled;
    },
    watch: () => () => {},
    ...(rename && {
      async rename(_source: string, name: string, newName: string) {
        find(name).name = newName;
      },
    }),
  };
  const noop = async () => {};
  return {
    id: "obs",
    meters: true,
    setVolume: noop,
    setMuted: noop,
    setMonitorType: noop,
    setSyncOffset: noop,
    setTracks: noop,
    filters,
  } as unknown as SoftwareAdapter;
}

const sources = [{ name: SOURCE, volumeDb: 0, muted: false, monitorType: "off", balance: 0.5, syncOffsetMs: 0, tracks: [1] }] as AudioSource[];

const savedChain = (): Stored[] => [
  { name: "Polarity", kind: "invert_polarity_filter", enabled: true, settings: {} },
  { name: "Old noise", kind: "noise_suppress_filter", enabled: true, settings: { suppress_level: -30 } },
  { name: "Gate", kind: "noise_gate_filter", enabled: false, settings: { open_threshold: -30, close_threshold: -40, attack_time: 25 } },
  { name: "Crop", kind: "crop_filter", enabled: true, settings: { left: 10 } },
  { name: "Comp", kind: "compressor_filter", enabled: true, settings: { ratio: 6, threshold: -20 } },
  { name: "Limit", kind: "limiter_filter", enabled: true, settings: { threshold: -2 } },
];

const audioOnly = (chain: Stored[]) => chain.filter((f) => f.kind !== "crop_filter");

describe("captureProfile", () => {
  it("saves every audio filter's kind, name, order, on/off and settings, and no video filters", async () => {
    const profile = await captureProfile(fakeAdapter(savedChain()), "p", sources);
    expect(profile.sources[0].filters).toEqual(audioOnly(savedChain()));
  });
});

describe.each([
  ["with rename (OBS)", true],
  ["without rename (Streamlabs)", false],
])("applyProfile %s", (_, rename) => {
  it("puts the audio filter chain back exactly as saved", async () => {
    const chain = savedChain();
    const adapter = fakeAdapter(chain, { rename });
    const profile = await captureProfile(adapter, "p", sources);

    // Change everything: remove, add, reorder, retune, toggle, rename.
    chain.splice(chain.findIndex((f) => f.name === "Comp"), 1);
    chain.push({ name: "Expander", kind: "expander_filter", enabled: true, settings: {} });
    chain.push({ name: "Gain", kind: "gain_filter", enabled: true, settings: { db: 6 } });
    chain.reverse();
    const gate = chain.find((f) => f.name === "Gate")!;
    gate.enabled = true;
    gate.settings = { open_threshold: -10, close_threshold: -40, attack_time: 25, extra: 1 };
    chain.find((f) => f.name === "Limit")!.name = "My limiter";

    const result = await applyProfile(adapter, profile, sources);
    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual([SOURCE]);
    expect(audioOnly(chain)).toEqual(audioOnly(savedChain()));
    // The video filter stays, below the audio ones.
    expect(chain.find((f) => f.kind === "crop_filter")).toEqual(savedChain()[3]);
    const removed = [`${SOURCE}：Expander`, `${SOURCE}：Gain`];
    expect(result.removedFilters.sort()).toEqual(rename ? removed : [...removed, `${SOURCE}：My limiter`].sort());
  });

  it("replaces an audio filter of another kind that has a saved filter's name", async () => {
    const chain = savedChain();
    const adapter = fakeAdapter(chain, { rename });
    const profile = await captureProfile(adapter, "p", sources);
    chain.find((f) => f.name === "Comp")!.kind = "gain_filter";

    const result = await applyProfile(adapter, profile, sources);
    expect(result.errors).toEqual([]);
    expect(audioOnly(chain)).toEqual(audioOnly(savedChain()));
    expect(result.removedFilters).toEqual([`${SOURCE}：Comp`]);
  });

  it("keeps going when one filter can't be created", async () => {
    const chain = savedChain();
    const profile = await captureProfile(fakeAdapter(chain), "p", sources);
    const adapter = fakeAdapter([{ name: "Expander", kind: "expander_filter", enabled: true, settings: {} }], { rename, failKinds: ["noise_gate_filter"] });

    const result = await applyProfile(adapter, profile, sources);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Gate");
    const restored = await adapter.filters!.list(SOURCE);
    expect(restored.map((f) => f.name)).toEqual(["Polarity", "Old noise", "Comp", "Limit"]);
    expect(result.removedFilters).toEqual([`${SOURCE}：Expander`]);
  });
});
