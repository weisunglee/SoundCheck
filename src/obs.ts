// Connection to OBS through obs-websocket: by default with the local OBS's own saved
// settings, or with details the user entered when those can't be used.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import OBSWebSocket, { EventSubscription, OBSWebSocketError } from "obs-websocket-js";
import { useCallback, useEffect, useRef, useState } from "react";

interface WebsocketConfig {
  enabled: boolean;
  port: number;
  password: string | null;
}

export const obs = new OBSWebSocket();

/** Why a connection attempt failed, so the UI can show the matching guide. */
export type ConnectFailure =
  | "noConfig" // no obs-websocket settings on this computer (OBS never run, or a portable install)
  | "disabled" // the WebSocket server is turned off in OBS
  | "refused" // nothing answered on the port (OBS not running, still starting, or another port)
  | "auth" // wrong password
  | "other";

export type ConnectionState =
  | { kind: "connecting" }
  | {
      kind: "connected";
      obsVersion: string;
      /** OBS runs on this computer, so the plugin tap, installer and system sound features apply. */
      local: boolean;
    }
  | { kind: "failed"; reason: ConnectFailure; message: string; manual: boolean };

/** Connection details the user typed in, used instead of OBS's own settings file. */
export interface ManualSettings {
  host: string;
  port: number;
  password: string;
}

const MANUAL_KEY = "obs-audio-kit.manual-connection";

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
    if (!config) throw new ConnectError("noConfig", "找不到這台電腦上的 OBS 設定。");
    if (!config.enabled) throw new ConnectError("disabled", "OBS 的 WebSocket 伺服器沒有開啟。");
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
      throw new ConnectError("auth", "OBS 拒絕了密碼。");
    }
    throw new ConnectError("refused", `連不上 OBS（${host}:${port}）。`);
  }
  return (await obs.call("GetVersion")).obsVersion;
}

/** Automatic settings always mean this computer; a typed host counts only if it is loopback. */
function isLoopback(host: string | undefined): boolean {
  return host === undefined || ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.trim().toLowerCase());
}

const RETRY_EVENT = "obs-audio-kit:retry-connection";

/** Drops any current connection and connects again right away with the latest settings. */
export function retryConnection() {
  window.dispatchEvent(new Event(RETRY_EVENT));
}

/**
 * Connects on mount and keeps trying until connected. Retries come from three places,
 * because the webview's own timer is throttled while the window is in the background:
 * - the native OBS watcher (`obs-presence`), which fires as soon as OBS's WebSocket is reachable
 * - the window becoming visible again
 * - a 3-second timer after each failed or dropped connection
 */
export function useObsConnection(): ConnectionState {
  const [state, setState] = useState<ConnectionState>({ kind: "connecting" });
  const stateRef = useRef(state);
  stateRef.current = state;
  const inFlight = useRef(false);
  const againAfter = useRef(false);

  const attempt = useCallback(function run() {
    if (inFlight.current) {
      // A trigger arrived mid-attempt (e.g. OBS just became ready); try once more afterwards.
      againAfter.current = true;
      return;
    }
    inFlight.current = true;
    if (stateRef.current.kind !== "failed") setState({ kind: "connecting" });
    const manual = loadManualSettings();
    connectToObs(manual)
      .then((obsVersion) => setState({ kind: "connected", obsVersion, local: isLoopback(manual?.host) }))
      .catch((e: Error) =>
        setState({
          kind: "failed",
          reason: e instanceof ConnectError ? e.reason : "other",
          message: e.message,
          manual: manual !== null,
        }),
      )
      .finally(() => {
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
      if (stateRef.current.kind === "connected") {
        setState({ kind: "failed", reason: "refused", message: "和 OBS 的連線中斷了，正在重新連線…", manual: loadManualSettings() !== null });
      }
      retryLater();
    };
    const onVisible = () => document.visibilityState === "visible" && notConnected() && attempt();
    const offPresence = listen<{ running: boolean; ready: boolean }>("obs-presence", (e) => {
      if (e.payload.ready && notConnected()) attempt();
    });

    const onRetry = () => {
      clearTimeout(timer);
      if (stateRef.current.kind === "connected") obs.disconnect().finally(attempt);
      else attempt();
    };

    attempt();
    obs.on("ConnectionClosed", onClosed);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(RETRY_EVENT, onRetry);
    return () => {
      clearTimeout(timer);
      obs.off("ConnectionClosed", onClosed);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(RETRY_EVENT, onRetry);
      offPresence.then((off) => off());
    };
  }, [attempt]);

  return state;
}

/** Calls one of the obs-audio-kit plugin's requests. */
export async function pluginRequest<T = Record<string, unknown>>(
  requestType: string,
  requestData: { [key: string]: string | number | boolean } = {},
): Promise<T> {
  try {
    const { responseData } = await obs.call("CallVendorRequest", {
      vendorName: "obs-audio-kit",
      requestType,
      requestData,
    });
    const data = responseData as { ok?: boolean; error?: string };
    if (data.ok === false) throw new Error(data.error ?? "外掛回報失敗");
    return data as T;
  } catch (e) {
    // obs-websocket answers 600 "No vendor was found by that name." when the plugin isn't loaded.
    if (e instanceof OBSWebSocketError && e.code === 600 && /vendor/i.test(e.message)) {
      throw new Error("OBS 裡沒有安裝 obs-audio-kit 外掛，試音需要它。");
    }
    throw e;
  }
}
