// Checks GitHub Releases for a newer SoundCheck, at start and on request, and installs it.
// The prompt at start can be put off for this run ("later") or for that version ("skip"); a
// check the user asks for always shows what it found. Copies that can't replace themselves
// (the Windows portable zip, dev builds) get the download page instead.
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { type Update, check } from "@tauri-apps/plugin-updater";
import { useEffect, useRef, useState } from "react";

const SKIP_KEY = "soundcheck.skippedUpdate";
/** How long after start to check, so the check doesn't compete with connecting. */
const START_DELAY_MS = 5000;

/** A version's release page, or the latest release's. */
export const releasePage = (version?: string) =>
  `https://github.com/weisunglee/SoundCheck/releases/${version ? `tag/v${version}` : "latest"}`;
export const openReleasePage = (version?: string) => openUrl(releasePage(version)).catch(() => {});

/** Whether the check at start should ask about `version`. */
export const promptAtStart = (version: string, skipped: string | null) => version !== skipped;

/** The start of the release notes, for the prompt; the release page has the rest. */
export function notesSummary(notes: string | undefined, max = 500): string {
  const text = (notes ?? "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lineEnd = cut.lastIndexOf("\n");
  return `${(lineEnd > max / 2 ? cut.slice(0, lineEnd) : cut).trimEnd()}…`;
}

function loadSkipped(): string | null {
  try {
    return localStorage.getItem(SKIP_KEY);
  } catch {
    return null;
  }
}

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; update: Update; received: number; total: number | null }
  | { kind: "installing"; update: Update }
  | { kind: "error"; message: string; update: Update | null };

export interface Updater {
  state: UpdateState;
  /** Whether the dialog is showing. */
  open: boolean;
  /** The version found, while it is neither skipped nor installed: the header points at it. */
  pending: string | null;
  /** False for copies that can't replace themselves: offer the download page. */
  canInstall: boolean;
  checkNow: () => void;
  install: () => void;
  later: () => void;
  skip: () => void;
  show: () => void;
}

/**
 * Checks once at start and on request. `hold` keeps the start prompt back (e.g. during a sound
 * test) until it turns false.
 */
export function useUpdater(hold: boolean): Updater {
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const [open, setOpen] = useState(false);
  const [wantsPrompt, setWantsPrompt] = useState(false);
  const [skipped, setSkipped] = useState(loadSkipped);
  const [canInstall, setCanInstall] = useState(true);
  const busy = useRef(false);

  const run = async (manual: boolean) => {
    if (busy.current) return;
    busy.current = true;
    if (manual) {
      setState({ kind: "checking" });
      setOpen(true);
    }
    try {
      const update = await check();
      if (!update) setState({ kind: "upToDate" });
      else {
        setState({ kind: "available", update });
        if (!manual && promptAtStart(update.version, loadSkipped())) setWantsPrompt(true);
      }
    } catch (e) {
      // A failed check at start (offline, GitHub down) isn't worth interrupting for.
      if (manual) setState({ kind: "error", message: String(e), update: null });
      else console.warn("update check failed:", e);
    } finally {
      busy.current = false;
    }
  };

  useEffect(() => {
    invoke<boolean>("can_install_updates")
      .then(setCanInstall)
      .catch(() => setCanInstall(false));
    const id = setTimeout(() => run(false), START_DELAY_MS);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    if (wantsPrompt && !hold) {
      setWantsPrompt(false);
      setOpen(true);
    }
  }, [wantsPrompt, hold]);

  const update = "update" in state ? state.update : null;

  const install = async () => {
    if (!update) return;
    let received = 0;
    let total: number | null = null;
    setState({ kind: "downloading", update, received, total });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? null;
        else if (event.event === "Progress") received += event.data.chunkLength;
        else if (event.event === "Finished") {
          setState({ kind: "installing", update });
          return;
        }
        setState({ kind: "downloading", update, received, total });
      });
      // Windows never gets here: the installer closes the app and opens the new version.
      await relaunch();
    } catch (e) {
      setState({ kind: "error", message: String(e), update });
    }
  };

  const skip = () => {
    if (!update) return;
    try {
      localStorage.setItem(SKIP_KEY, update.version);
    } catch {
      // Only skipped for this run.
    }
    setSkipped(update.version);
    setOpen(false);
  };

  const found = state.kind === "available" || state.kind === "error" ? update : null;
  return {
    state,
    open,
    pending: found && found.version !== skipped ? found.version : null,
    canInstall,
    checkNow: () => void run(true),
    install: () => void install(),
    later: () => setOpen(false),
    skip,
    show: () => setOpen(true),
  };
}
