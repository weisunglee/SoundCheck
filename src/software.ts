// The streaming software SoundCheck can talk to, and which one the user picked. What each one
// can do is in its adapter (src/adapter.ts).

export type SoftwareId = "obs" | "streamlabs";

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
