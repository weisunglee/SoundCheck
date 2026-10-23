import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { type ConnectionState, loadManualSettings, retryConnection, saveManualSettings } from "../obs";

type Failed = Extract<ConnectionState, { kind: "failed" }>;

interface Props {
  failure: Failed;
  /** From the native process check; null while unknown. */
  obsRunning: boolean | null;
}

const OBS_MENU_PATH = "「工具」→「WebSocket 伺服器設定」";

/** What to do next, for each way connecting to OBS can fail. */
export function ConnectionGuide({ failure, obsRunning }: Props) {
  const [showManual, setShowManual] = useState(failure.manual);

  const openObs = obsRunning === false && (
    <button type="button" className="btn primary" onClick={() => invoke("launch_obs").catch(() => {})}>
      開啟 OBS
    </button>
  );

  let title: string;
  let body: React.ReactNode;
  switch (failure.reason) {
    case "disabled":
      title = "請在 OBS 開啟 WebSocket 伺服器";
      body = (
        <>
          <p>這個工具透過 OBS 內建的 WebSocket 伺服器和 OBS 溝通。只要開啟一次，之後都會自動連線。</p>
          <ol className="guide-steps">
            {obsRunning === false && <li>開啟 OBS。</li>}
            <li>在 OBS 上方選單按 {OBS_MENU_PATH}。</li>
            <li>勾選「啟用 WebSocket 伺服器」。「啟用驗證」保持勾選就好，密碼不用抄，這個工具會自己讀取。</li>
            <li>按「確定」。</li>
          </ol>
          <p className="hint">完成後這裡會自動連上，不用重開這個工具。</p>
          {openObs}
        </>
      );
      break;
    case "noConfig":
      title = "找不到這台電腦上的 OBS 設定";
      body = (
        <>
          <p>通常是因為這台電腦還沒開過 OBS 28 以上的版本，或用的是可攜版 OBS（設定存在 OBS 資料夾裡）。</p>
          <ul className="guide-list">
            <li>還沒開過 OBS：先開啟 OBS 一次，再照提示開啟 WebSocket 伺服器。</li>
            <li>可攜版 OBS，或 OBS 在另一台電腦：用下面的「手動輸入連線資料」。</li>
          </ul>
          {openObs}
        </>
      );
      break;
    case "auth":
      title = "密碼不對";
      body = failure.manual ? (
        <p>
          請到 OBS {OBS_MENU_PATH}，按「顯示連線資訊」，複製「伺服器密碼」貼到下面。
        </p>
      ) : (
        <p>
          OBS 設定檔裡的密碼和 OBS 正在使用的不一樣。請到 OBS {OBS_MENU_PATH} 直接按「確定」，讓 OBS 重新存一次設定，這裡就會自動連上。
        </p>
      );
      break;
    case "refused":
      if (obsRunning === false && !failure.manual) {
        title = "OBS 沒有在執行";
        body = (
          <>
            <p>開啟 OBS 後這裡會自動連上。</p>
            {openObs}
          </>
        );
      } else {
        title = "連不上 OBS";
        body = (
          <>
            <p>{failure.message}</p>
            <ul className="guide-list">
              <li>OBS 剛開啟的話，等幾秒就會連上。</li>
              <li>
                確認 OBS {OBS_MENU_PATH} 裡的連接埠，和{failure.manual ? "下面填的" : "這個工具讀到的"}一樣。
              </li>
              <li>其他程式佔用了這個連接埠時，可以在 OBS 改用別的連接埠。</li>
            </ul>
          </>
        );
      }
      break;
    default:
      title = "連不上 OBS";
      body = <p>{failure.message}</p>;
  }

  return (
    <div className="guide">
      <h2>{title}</h2>
      {body}
      <p className="hint">連上之前會每 3 秒自動重試。</p>

      {showManual ? (
        <ManualForm onCancel={failure.manual ? undefined : () => setShowManual(false)} />
      ) : (
        <button type="button" className="link" onClick={() => setShowManual(true)}>
          手動輸入連線資料
        </button>
      )}
    </div>
  );
}

function ManualForm({ onCancel }: { onCancel?: () => void }) {
  const saved = loadManualSettings();
  const [host, setHost] = useState(saved?.host ?? "127.0.0.1");
  const [port, setPort] = useState(String(saved?.port ?? 4455));
  const [password, setPassword] = useState(saved?.password ?? "");
  const portNumber = Number(port);
  const valid = host.trim() !== "" && Number.isInteger(portNumber) && portNumber > 0 && portNumber < 65536;

  const connect = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    saveManualSettings({ host: host.trim(), port: portNumber, password });
    retryConnection();
  };

  const useAuto = () => {
    saveManualSettings(null);
    retryConnection();
    onCancel?.();
  };

  return (
    <form className="manual" onSubmit={connect}>
      <p className="hint">這些資料在 OBS {OBS_MENU_PATH} 按「顯示連線資訊」就看得到。</p>
      <label className="field">
        <span className="field-label">伺服器 IP</span>
        <input id="manual-host" value={host} onChange={(e) => setHost(e.target.value)} autoComplete="off" />
      </label>
      <label className="field">
        <span className="field-label">連接埠</span>
        <input id="manual-port" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
      </label>
      <label className="field">
        <span className="field-label">密碼（沒有啟用驗證就留空）</span>
        <input id="manual-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
      </label>
      <div className="row">
        <button type="submit" className="btn primary" disabled={!valid}>
          連線
        </button>
        {saved ? (
          <button type="button" className="btn" onClick={useAuto}>
            改回自動讀取 OBS 設定
          </button>
        ) : (
          onCancel && (
            <button type="button" className="btn" onClick={onCancel}>
              取消
            </button>
          )
        )}
      </div>
    </form>
  );
}
