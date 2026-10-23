// The streaming software SoundCheck talks to, and what each one lets it do.

export type SoftwareId = "obs" | "streamlabs";

/** What the connected software exposes; the UI hides whatever is false. */
export interface Capabilities {
  /** Live per-source level meters. */
  meters: boolean;
  /** Change a source's monitoring mode. */
  monitoringControl: boolean;
  /** Change which tracks a source is sent to. */
  tracksControl: boolean;
  balance: boolean;
  syncOffset: boolean;
  /** Read and edit audio filters (the filter wizard). */
  filters: boolean;
  /** The SoundCheck plugin: sound test, stream meter, plugin installer. */
  plugin: boolean;
  /** Save and apply audio profiles. */
  profiles: boolean;
}

export const CAPABILITIES: Record<SoftwareId, Capabilities> = {
  obs: { meters: true, monitoringControl: true, tracksControl: true, balance: true, syncOffset: true, filters: true, plugin: true, profiles: true },
  // Streamlabs Desktop's local API can read these settings but only set volume and mute,
  // has no filter or level-meter API, and does not load third-party OBS plugins.
  streamlabs: { meters: false, monitoringControl: false, tracksControl: false, balance: false, syncOffset: false, filters: false, plugin: false, profiles: false },
};

export const SOFTWARE_NAMES: Record<SoftwareId, string> = { obs: "OBS", streamlabs: "Streamlabs" };

/** "auto" connects to whichever is running, preferring OBS. */
export type SoftwareChoice = "auto" | SoftwareId;
const CHOICE_KEY = "soundcheck.software";

export function loadSoftwareChoice(): SoftwareChoice {
  try {
    const saved = localStorage.getItem(CHOICE_KEY);
    if (saved === "obs" || saved === "streamlabs") return saved;
  } catch {
    // Storage unavailable: use auto.
  }
  return "auto";
}

export function saveSoftwareChoice(choice: SoftwareChoice) {
  try {
    localStorage.setItem(CHOICE_KEY, choice);
  } catch {
    // Only lasts for this session.
  }
}
