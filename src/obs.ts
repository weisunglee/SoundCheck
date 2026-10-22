// Connection to the local OBS through obs-websocket, using OBS's own saved settings.
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

export type ConnectionState =
  | { kind: "connecting" }
  | { kind: "connected"; obsVersion: string }
  | { kind: "failed"; message: string };

const RETRY_MS = 3000;

async function connectLocal(): Promise<string> {
  const config = await invoke<WebsocketConfig | null>("read_obs_websocket_config");
  if (!config) throw new Error("找不到 OBS 的設定。請先在這台電腦上開啟過一次 OBS。");
  if (!config.enabled) throw new Error("OBS 的 WebSocket 伺服器沒有開啟。請到 OBS「工具 → WebSocket 伺服器設定」勾選「啟用 WebSocket 伺服器」。");
  try {
    await obs.connect(`ws://127.0.0.1:${config.port}`, config.password ?? undefined, {
      // Volume meters are a high-volume event and must be requested explicitly.
      eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters,
    });
  } catch {
    throw new Error(`連不上 OBS（連接埠 ${config.port}）。請確認 OBS 正在執行。`);
  }
  return (await obs.call("GetVersion")).obsVersion;
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
    connectLocal()
      .then((obsVersion) => setState({ kind: "connected", obsVersion }))
      .catch((e: Error) => setState({ kind: "failed", message: e.message }))
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
        setState({ kind: "failed", message: "和 OBS 的連線中斷了，正在重新連線…" });
      }
      retryLater();
    };
    const onVisible = () => document.visibilityState === "visible" && notConnected() && attempt();
    const offPresence = listen<{ running: boolean; ready: boolean }>("obs-presence", (e) => {
      if (e.payload.ready && notConnected()) attempt();
    });

    attempt();
    obs.on("ConnectionClosed", onClosed);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      obs.off("ConnectionClosed", onClosed);
      document.removeEventListener("visibilitychange", onVisible);
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
