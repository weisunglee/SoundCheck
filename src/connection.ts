// Connection to the streaming software: OBS through obs-websocket (by default with the local
// OBS's own saved settings, or with details the user entered), or Streamlabs Desktop through
// its local API (see streamlabs.ts).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { EventSubscription, OBSWebSocketError } from "obs-websocket-js";
import { useCallback, useEffect, useRef, useState } from "react";
import { setSoftwareName, t } from "./i18n";
import { obs } from "./obsClient";
import { SOFTWARE_NAMES, type SoftwareChoice, type SoftwareId, loadSoftwareChoice } from "./software";
import { streamlabs } from "./streamlabs";

interface WebsocketConfig {
  enabled: boolean;
  port: number;
  password: string | null;
}

/** Why a connection attempt failed, so the UI can show the matching guide. */
export type ConnectFailure =
  | "noConfig" // no obs-websocket settings on this computer (OBS never run, or a portable install)
  | "disabled" // the WebSocket server is turned off in OBS
  | "refused" // nothing answered on the port (OBS not running, still starting, or another port)
  | "auth" // wrong password
  | "streamlabsNotRunning" // Streamlabs chosen, but its local API isn't open
  | "other";

export type ConnectionState =
  | { kind: "connecting" }
  | {
      kind: "connected";
      software: SoftwareId;
      /** Empty when the software doesn't report one. */
      version: string;
      /** The software runs on this computer, so the plugin tap, installer and system sound features apply. */
      local: boolean;
    }
  | { kind: "failed"; software: SoftwareId; reason: ConnectFailure; message: string; manual: boolean };

/** What the native watcher last saw running (see src-tauri/src/presence.rs). */
export interface SoftwarePresence {
  obs: { running: boolean; ready: boolean };
  streamlabs: { running: boolean; ready: boolean };
}

const NOTHING_SEEN: SoftwarePresence = { obs: { running: false, ready: false }, streamlabs: { running: false, ready: false } };

/** Connection details the user typed in, used instead of OBS's own settings file. */
export interface ManualSettings {
  host: string;
  port: number;
  password: string;
}

const MANUAL_KEY = "soundcheck.manual-connection";

export function loadManualSettings(): ManualSettings | null {
  try {
    const raw = localStorage.getItem(MANUAL_KEY);
    return raw ? (JSON.parse(raw) as ManualSettings) : null;
  } catch {
    return null;
  }
}

/** Saves manual settings, or goes back to reading OBS's settings file with `null`. */
export function saveManualSettings(settings: ManualSettings | null) {
  try {
    if (settings) localStorage.setItem(MANUAL_KEY, JSON.stringify(settings));
    else localStorage.removeItem(MANUAL_KEY);
  } catch {
    // Storage unavailable: the settings only last for this session.
  }
}

class ConnectError extends Error {
  constructor(
    readonly reason: ConnectFailure,
    message: string,
  ) {
    super(message);
  }
}

/** obs-websocket closes the socket with this code when the password is wrong. */
const AUTHENTICATION_FAILED = 4009;

const RETRY_MS = 3000;

async function connectToObs(manual: ManualSettings | null): Promise<string> {
  let host = "127.0.0.1";
  let port: number;
  let password: string | undefined;
  if (manual) {
    ({ host, port } = manual);
    password = manual.password || undefined;
  } else {
    const config = await invoke<WebsocketConfig | null>("read_obs_websocket_config");
    if (!config) throw new ConnectError("noConfig", t("找不到這台電腦上的直播軟體設定。"));
    if (!config.enabled) throw new ConnectError("disabled", t("{app} 的 WebSocket 伺服器沒有開啟。", { app: SOFTWARE_NAMES.obs }));
    port = config.port;
    password = config.password ?? undefined;
  }

  try {
    await obs.connect(`ws://${host}:${port}`, password, {
      // Volume meters are a high-volume event and must be requested explicitly.
      eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters,
    });
  } catch (e) {
    if (e instanceof OBSWebSocketError && e.code === AUTHENTICATION_FAILED) {
      throw new ConnectError("auth", t("直播軟體拒絕了密碼。"));
    }
    throw new ConnectError("refused", t("連不上直播軟體（{address}）。", { address: `${host}:${port}` }));
  }
  return (await obs.call("GetVersion")).obsVersion;
}

/** Automatic settings always mean this computer; a typed host counts only if it is loopback. */
function isLoopback(host: string | undefined): boolean {
  return host === undefined || ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.trim().toLowerCase());
}

const RETRY_EVENT = "soundcheck:retry-connection";

async function connectToStreamlabs(presence: SoftwarePresence): Promise<void> {
  if (!presence.streamlabs.ready) throw new ConnectError("streamlabsNotRunning", t("直播軟體沒有在執行，或還沒準備好。"));
  try {
    await streamlabs.connect();
    // Any request proves the API answers (it holds requests while a scene collection loads).
    await streamlabs.request("ScenesService", "activeSceneId");
  } catch {
    streamlabs.disconnect();
    throw new ConnectError("streamlabsNotRunning", t("連不上直播軟體"));
  }
}

/**
 * Which software to try, in order. In auto mode Streamlabs is only tried when it is actually
 * running, so a user with neither open is guided towards OBS, the fully supported one.
 */
export function connectionOrder(choice: SoftwareChoice, seen: SoftwarePresence): SoftwareId[] {
  if (choice !== "auto") return [choice];
  if (!seen.streamlabs.ready) return ["obs"];
  return seen.obs.running ? ["obs", "streamlabs"] : ["streamlabs"];
}

/** Drops any current connection and connects again right away with the latest settings. */
export function retryConnection() {
  window.dispatchEvent(new Event(RETRY_EVENT));
}

/**
 * Connects on mount and keeps trying until connected, to OBS or Streamlabs as the user chose
 * ("auto" picks whichever is running, OBS first). Retries come from three places, because the
 * webview's own timer is throttled while the window is in the background:
 * - the native watcher (`software-presence`), which fires as soon as the software is reachable
 * - the window becoming visible again
 * - a 3-second timer after each failed or dropped connection
 */
export function useConnection(): { state: ConnectionState; presence: SoftwarePresence } {
  const [state, setState] = useState<ConnectionState>({ kind: "connecting" });
  const [presence, setPresence] = useState<SoftwarePresence>(NOTHING_SEEN);
  const stateRef = useRef(state);
  stateRef.current = state;
  const presenceRef = useRef(presence);
  presenceRef.current = presence;
  const inFlight = useRef(false);
  const againAfter = useRef(false);

  const attempt = useCallback(function run() {
    if (inFlight.current) {
      // A trigger arrived mid-attempt (e.g. the software just became ready); try once more afterwards.
      againAfter.current = true;
      return;
    }
    inFlight.current = true;
    if (stateRef.current.kind !== "failed") setState({ kind: "connecting" });
    const order = connectionOrder(loadSoftwareChoice(), presenceRef.current);
    const manual = loadManualSettings();

    (async () => {
      let firstError: { software: SoftwareId; error: Error } | null = null;
      for (const software of order) {
        try {
          let connected: ConnectionState;
          if (software === "obs") {
            connected = { kind: "connected", software, version: await connectToObs(manual), local: isLoopback(manual?.host) };
          } else {
            await connectToStreamlabs(presenceRef.current);
            connected = { kind: "connected", software, version: "", local: true };
          }
          // The UI's {app} only changes once the outcome is known, so it never shows the one being tried.
          setSoftwareName(SOFTWARE_NAMES[software]);
          setState(connected);
          return;
        } catch (e) {
          firstError ??= { software, error: e as Error };
        }
      }
      const { software, error } = firstError!;
      setSoftwareName(SOFTWARE_NAMES[software]);
      setState({
        kind: "failed",
        software,
        reason: error instanceof ConnectError ? error.reason : "other",
        message: error.message,
        manual: software === "obs" && manual !== null,
      });
    })().finally(() => {
      inFlight.current = false;
      if (againAfter.current && stateRef.current.kind !== "connected") {
        againAfter.current = false;
        run();
      }
    });
  }, []);

  useEffect(() => {
    const notConnected = () => stateRef.current.kind !== "connected";
    let timer: ReturnType<typeof setTimeout>;
    const retryLater = () => {
      clearTimeout(timer);
      timer = setTimeout(() => notConnected() && attempt(), RETRY_MS);
    };

    // Fires both when a live connection drops and when a connection attempt fails.
    const onClosed = () => {
      const current = stateRef.current;
      if (current.kind === "connected") {
        setState({
          kind: "failed",
          software: current.software,
          reason: "refused",
          message: t("和直播軟體的連線中斷了，正在重新連線…"),
          manual: current.software === "obs" && loadManualSettings() !== null,
        });
      }
      retryLater();
    };
    const onVisible = () => document.visibilityState === "visible" && notConnected() && attempt();
    const offPresence = listen<SoftwarePresence>("software-presence", (e) => {
      presenceRef.current = e.payload;
      setPresence(e.payload);
      if ((e.payload.obs.ready || e.payload.streamlabs.ready) && notConnected()) attempt();
    });

    const onRetry = () => {
      clearTimeout(timer);
      const current = stateRef.current;
      if (current.kind === "connected") {
        if (current.software === "streamlabs") streamlabs.disconnect();
        else obs.disconnect().catch(() => {});
      }
      attempt();
    };

    attempt();
    obs.on("ConnectionClosed", onClosed);
    const offStreamlabsClose = streamlabs.onClose(onClosed);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(RETRY_EVENT, onRetry);
    return () => {
      clearTimeout(timer);
      obs.off("ConnectionClosed", onClosed);
      offStreamlabsClose();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(RETRY_EVENT, onRetry);
      offPresence.then((off) => off());
    };
  }, [attempt]);

  return { state, presence };
}
