// Which strips suggest voice tuning: mics that aren't tuned yet, unless the user said no thanks.
import { describe, expect, it } from "vitest";
import { VOICE_EQ_KIND } from "./plugin";
import type { Filter } from "./types";
import { dismissKey, isMicSource, isVoiceTuned, shouldSuggestVoiceTuning } from "./voiceGuide";

const mic = (filters: Filter[] = [], name = "Mic") => ({ name, inputKind: "wasapi_input_capture", filters });
const none = new Set<string>();

describe("isMicSource", () => {
  it("knows input captures on every platform", () => {
    for (const inputKind of ["wasapi_input_capture", "coreaudio_input_capture", "pulse_input_capture"]) expect(isMicSource({ inputKind })).toBe(true);
  });
  it("leaves out desktop audio, app captures and media", () => {
    for (const inputKind of ["wasapi_output_capture", "wasapi_process_output_capture", "sck_audio_capture", "ffmpeg_source", ""])
      expect(isMicSource({ inputKind })).toBe(false);
  });
});

describe("shouldSuggestVoiceTuning", () => {
  it("suggests it on an untuned mic when voice tuning is available", () => {
    expect(shouldSuggestVoiceTuning(mic([{ name: "Noise", kind: "noise_suppress_filter_v2", enabled: true }]), "obs", true, none)).toBe(true);
  });
  it("stops once the voice EQ is on the mic, even turned off", () => {
    const tuned = mic([{ name: "Voice EQ", kind: VOICE_EQ_KIND, enabled: false }]);
    expect(isVoiceTuned(tuned)).toBe(true);
    expect(shouldSuggestVoiceTuning(tuned, "obs", true, none)).toBe(false);
  });
  it("needs voice tuning and a mic", () => {
    expect(shouldSuggestVoiceTuning(mic(), "obs", false, none)).toBe(false);
    expect(shouldSuggestVoiceTuning({ ...mic(), inputKind: "wasapi_output_capture" }, "obs", true, none)).toBe(false);
  });
  it("remembers no thanks per software and source", () => {
    const dismissed = new Set([dismissKey("obs", "Mic")]);
    expect(shouldSuggestVoiceTuning(mic(), "obs", true, dismissed)).toBe(false);
    expect(shouldSuggestVoiceTuning(mic(), "streamlabs", true, dismissed)).toBe(true);
    expect(shouldSuggestVoiceTuning(mic([], "Headset"), "obs", true, dismissed)).toBe(true);
  });
});
