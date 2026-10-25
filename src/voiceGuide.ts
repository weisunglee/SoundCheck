// Points mic owners at voice tuning: a card on each mic's strip until the mic is tuned or the
// user says no thanks. "No thanks" is remembered per streaming software and source name.
import { VOICE_EQ_KIND } from "./plugin";
import type { SoftwareId } from "./software";
import { CAPTURE_KINDS } from "./systemAudio";
import type { AudioSource } from "./types";

const DISMISSED_KEY = "soundcheck.voiceTuningDismissed";

/** A mic or other input device capture; OBS and Streamlabs both report the libobs kind. */
export const isMicSource = (source: Pick<AudioSource, "inputKind">) =>
  (CAPTURE_KINDS.input as readonly string[]).includes(source.inputKind);

/** Voice tuning has set this source up already (its voice EQ is in the chain, on or off). */
export const isVoiceTuned = (source: Pick<AudioSource, "filters">) => source.filters.some((f) => f.kind === VOICE_EQ_KIND);

export const dismissKey = (software: SoftwareId, source: string) => `${software}\n${source}`;

export function shouldSuggestVoiceTuning(
  source: Pick<AudioSource, "name" | "inputKind" | "filters">,
  software: SoftwareId,
  voiceTuning: boolean,
  dismissed: ReadonlySet<string>,
): boolean {
  return voiceTuning && isMicSource(source) && !isVoiceTuned(source) && !dismissed.has(dismissKey(software, source.name));
}

export function loadDismissed(): Set<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]");
    return new Set(Array.isArray(saved) ? saved.filter((k): k is string => typeof k === "string") : []);
  } catch {
    // Storage unavailable or unreadable: suggest again.
    return new Set();
  }
}

export function saveDismissed(dismissed: ReadonlySet<string>) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissed]));
  } catch {
    // Only lasts for this session.
  }
}
