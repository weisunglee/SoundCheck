// Small pure helpers: version comparison, the IEC fader curve, loudness verdicts, and how
// system audio maps onto captures in the streaming software.
import { describe, expect, it } from "vitest";
import { loudnessVerdict } from "./loudnessVerdict";
import { type PluginFiles, assessPlugin, compareVersions, pluginApplies } from "./plugin";
import { iecDbToDeflection } from "./streamlabs";
import { type SystemApp, type SystemDevice, appCoverage, deviceCoverage, obsWindowString } from "./systemAudio";

describe("compareVersions", () => {
  it("compares numerically, not as text", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.2.1", "0.2.1")).toBe(0);
    expect(compareVersions("0.2", "0.2.0")).toBe(0);
    expect(compareVersions("0.2.0", "0.3.0")).toBeLessThan(0);
  });
});

describe("assessPlugin", () => {
  const files = (patch: Partial<PluginFiles> = {}): PluginFiles => ({
    bundledVersion: "0.3.0",
    installed: true,
    installedVersion: "0.3.0",
    legacyInstalled: false,
    obsRunning: true,
    enabledInPluginManager: true,
    ...patch,
  });

  it("trusts the version OBS has loaded over the file on disk", () => {
    expect(assessPlugin(files({ installedVersion: "0.1.0" }), "0.3.0", true)).toEqual({ need: "none", fileCurrent: false, loadedCurrent: true });
    expect(assessPlugin(files(), "0.2.1", true).need).toBe("update");
  });
  it("asks to install when nothing is on disk, and to update an older file", () => {
    expect(assessPlugin(files({ installed: false, installedVersion: null }), null, false).need).toBe("install");
    expect(assessPlugin(files({ installedVersion: "0.2.1" }), null, false).need).toBe("update");
  });
  it("reports a current file that OBS hasn't loaded only while connected", () => {
    expect(assessPlugin(files(), null, true).need).toBe("notLoaded");
    expect(assessPlugin(files(), null, false).need).toBe("none");
  });
  it("needs nothing when the app bundles no plugin", () => {
    expect(assessPlugin(files({ bundledVersion: null, installed: false }), null, true).need).toBe("none");
  });
});

describe("pluginApplies", () => {
  it("applies to OBS on this computer and to connections not made yet", () => {
    expect(pluginApplies({ kind: "connected", software: "obs", version: "32", local: true })).toBe(true);
    expect(pluginApplies({ kind: "connected", software: "obs", version: "32", local: false })).toBe(false);
    expect(pluginApplies({ kind: "connected", software: "streamlabs", version: "", local: true })).toBe(false);
    expect(pluginApplies({ kind: "connecting" })).toBe(true);
    expect(pluginApplies({ kind: "failed", software: "streamlabs", reason: "streamlabsNotRunning", message: "", manual: false })).toBe(false);
  });
});

describe("iecDbToDeflection", () => {
  // Points computed from libobs's iec_db_to_def: segment boundaries and middles.
  const cases: [number, number][] = [
    [0, 1], [-4.5, 0.875], [-9, 0.75], [-14.5, 0.625], [-20, 0.5], [-25, 0.4], [-30, 0.3],
    [-35, 0.225], [-40, 0.15], [-45, 0.1125], [-50, 0.075], [-55, 0.05], [-60, 0.025],
    [-105, 0.0125], [-114, 0.01], [-200, 0],
  ];
  it.each(cases)("%f dB -> %f", (db, deflection) => {
    expect(iecDbToDeflection(db)).toBeCloseTo(deflection, 9);
  });
  it("never decreases as dB rises", () => {
    let previous = -1;
    for (let db = -120; db <= 0; db += 0.5) {
      const d = iecDbToDeflection(db);
      expect(d).toBeGreaterThanOrEqual(previous);
      previous = d;
    }
  });
});

describe("loudnessVerdict", () => {
  it("calls silence and clipping bad before judging loudness", () => {
    expect(loudnessVerdict(null, null).tone).toBe("bad");
    expect(loudnessVerdict(-18, -0.5).tone).toBe("bad");
    expect(loudnessVerdict(-18, -6, true).tone).toBe("bad");
  });
  it("warns outside -24..-10 LUFS and is fine inside", () => {
    expect(loudnessVerdict(-30, -12).tone).toBe("warn");
    expect(loudnessVerdict(-8, -3).tone).toBe("warn");
    expect(loudnessVerdict(-16, -6).tone).toBe("ok");
  });
});

describe("system audio coverage", () => {
  const devices: SystemDevice[] = [
    { id: "{out-1}", name: "Speakers", flow: "render", isDefault: true, peak: 0 },
    { id: "{out-2}", name: "Headset", flow: "render", isDefault: false, peak: 0 },
    { id: "{in-1}", name: "Mic", flow: "capture", isDefault: true, peak: 0 },
  ];
  const spotify: SystemApp = { pid: 1, exe: "Spotify.exe", windowTitle: "Spotify: a:b", windowClass: "Chrome_WidgetWin_0", deviceId: "{out-1}", peak: 0.2 };

  it("escapes # and : in the window string the way OBS stores it", () => {
    expect(obsWindowString(spotify)).toBe("Spotify#3A a#3Ab:Chrome_WidgetWin_0:Spotify.exe");
  });

  it("resolves the default device setting to the current default", () => {
    const captures = new Map([["Desktop", { kind: "wasapi_output_capture", settings: { device_id: "default" } }]]);
    expect(deviceCoverage(devices[0], captures, devices).sources).toEqual(["Desktop"]);
    expect(deviceCoverage(devices[1], captures, devices).sources).toEqual([]);
  });

  it("matches app captures by executable, case-insensitively", () => {
    const captures = new Map([["Music", { kind: "wasapi_process_output_capture", settings: { window: "x:y:spotify.EXE" } }]]);
    expect(appCoverage(spotify, captures, devices)).toEqual({ sources: ["Music"], viaDevice: false });
  });

  it("counts an app as captured through desktop audio on its device", () => {
    const captures = new Map([["Desktop", { kind: "wasapi_output_capture", settings: { device_id: "{out-1}" } }]]);
    expect(appCoverage(spotify, captures, devices)).toEqual({ sources: ["Desktop"], viaDevice: true });
    expect(appCoverage({ ...spotify, deviceId: "{out-2}" }, captures, devices).sources).toEqual([]);
  });
});
