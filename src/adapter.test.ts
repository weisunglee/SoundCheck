// What the UI offers follows from what each adapter implements, and profiles saved with OBS's
// monitoring names still apply.
import { describe, expect, it } from "vitest";
import { capabilitiesOf } from "./adapter";
import { obsAdapter } from "./obsAdapter";
import { profileMonitorType } from "./profiles";
import { streamlabsAdapter } from "./streamlabsAdapter";

describe("capabilitiesOf", () => {
  it("gives OBS everything", () => {
    expect(Object.values(capabilitiesOf(obsAdapter)).every(Boolean)).toBe(true);
  });
  it("gives Streamlabs everything but balance, and meters only with the plugin", () => {
    expect(capabilitiesOf(streamlabsAdapter, true).meters).toBe(true);
    expect(capabilitiesOf(streamlabsAdapter)).toEqual({
      meters: false,
      monitoringControl: true,
      tracksControl: true,
      balance: false,
      syncOffset: true,
      filters: true,
      plugin: true,
      profiles: true,
      voiceTuning: true,
    });
  });
  it("offers profiles without balance, but not without filters", () => {
    const { setBalance: _, ...withoutBalance } = obsAdapter;
    expect(capabilitiesOf(withoutBalance).profiles).toBe(true);
    const { filters: __, ...withoutFilters } = obsAdapter;
    expect(capabilitiesOf(withoutFilters).profiles).toBe(false);
  });
});

describe("profileMonitorType", () => {
  it("reads both the neutral names and OBS's names from older profiles", () => {
    expect(profileMonitorType("monitorOnly")).toBe("monitorOnly");
    expect(profileMonitorType("OBS_MONITORING_TYPE_MONITOR_ONLY")).toBe("monitorOnly");
    expect(profileMonitorType("OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT")).toBe("monitorAndOutput");
    expect(profileMonitorType("OBS_MONITORING_TYPE_NONE")).toBe("off");
    expect(profileMonitorType("garbage")).toBe("off");
  });
});
