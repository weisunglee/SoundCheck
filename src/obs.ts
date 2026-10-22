// Connection to the local OBS through obs-websocket, using OBS's own saved settings.
import { invoke } from "@tauri-apps/api/core";
import OBSWebSocket, { OBSWebSocketError } from "obs-websocket-js";
import { useCallback, useEffect, useState } from "react";

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
    await obs.connect(`ws://127.0.0.1:${config.port}`, config.password ?? undefined);
  } catch {
    throw new Error(`連不上 OBS（連接埠 ${config.port}）。請確認 OBS 正在執行。`);
  }
  return (await obs.call("GetVersion")).obsVersion;
}

/** Connects on mount and reconnects whenever OBS closes the connection. */
export function useObsConnection(): ConnectionState {
  const [state, setState] = useState<ConnectionState>({ kind: "connecting" });

  const attempt = useCallback(() => {
    setState({ kind: "connecting" });
    connectLocal()
      .then((obsVersion) => setState({ kind: "connected", obsVersion }))
      .catch((e: Error) => setState({ kind: "failed", message: e.message }));
  }, []);

  useEffect(() => {
    attempt();
    let timer: ReturnType<typeof setTimeout>;
    const onClosed = () => {
      setState({ kind: "failed", message: "和 OBS 的連線中斷了，正在重新連線…" });
      timer = setTimeout(attempt, RETRY_MS);
    };
    obs.on("ConnectionClosed", onClosed);
    return () => {
      clearTimeout(timer);
      obs.off("ConnectionClosed", onClosed);
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
