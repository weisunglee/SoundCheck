// "What's new" notices: one per app version that brings something users should hear about,
// shown once after the app connects. Only the newest one not seen yet is shown, and closing it
// marks everything up to its version seen, so a fresh install sees one notice, not a backlog.
import { msg } from "./i18n";

const SEEN_KEY = "soundcheck.whatsNewSeen";

/** What the notice's button does; the app decides how (it knows the sources and dialogs). */
export type NoticeAction = "voiceTuning";

export interface Notice {
  /** The app version that introduces it; also its id. */
  version: string;
  title: string;
  body: string;
  action?: NoticeAction;
}

/** Oldest first. Texts are translated where shown. */
export const NOTICES: Notice[] = [
  {
    version: "0.4.1",
    title: msg("新功能：自動調整人聲"),
    body: msg("說一段話，自動調好麥克風的等化、壓縮和音量。"),
    action: "voiceTuning",
  },
];

/** Negative when `a` is older than `b`; versions are x.y.z, missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The newest notice newer than `seen` (the last version whose notice was closed), if any. */
export function pickNotice(notices: readonly Notice[], seen: string | null): Notice | null {
  const unseen = notices.filter((n) => seen === null || compareVersions(n.version, seen) > 0);
  return unseen.reduce<Notice | null>((newest, n) => (!newest || compareVersions(n.version, newest.version) > 0 ? n : newest), null);
}

export function loadSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

export function saveSeen(version: string) {
  try {
    localStorage.setItem(SEEN_KEY, version);
  } catch {
    // Shown again next start.
  }
}
