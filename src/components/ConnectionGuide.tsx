import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { type ConnectionState, type SoftwarePresence, loadManualSettings, retryConnection, saveManualSettings } from "../connection";
import { SoftwarePicker } from "./SoftwarePicker";
import { t } from "../i18n";

type Failed = Extract<ConnectionState, { kind: "failed" }>;

interface Props {
  failure: Failed;
  /** What the native watcher sees running. */
  presence: SoftwarePresence;
}

const obsMenuPath = () => t("「工具」→「WebSocket 伺服器設定」");

/** What to do next, for each way connecting to the streaming software can fail. */
export function ConnectionGuide({ failure, presence }: Props) {
  const [showManual, setShowManual] = useState(failure.manual);
  const obsRunning = presence.obs.running;
  const isObs = failure.software === "obs";

  const openObs = obsRunning === false && (
    <button type="button" className="btn primary" onClick={() => invoke("launch_obs").catch(() => {})}>
      {t("開啟直播軟體")}
    </button>
  );

  let title: string;
  let body: React.ReactNode;
  switch (failure.reason) {
    case "streamlabsNotRunning":
      title = t("Streamlabs 沒有在執行");
      body = (
        <>
          <p>{t("開啟 Streamlabs Desktop 後這裡會自動連上，不需要設定或輸入 Token。")}</p>
          <p className="hint">{t("Streamlabs 能讓 SoundCheck 調整的項目比較少：可以調音量、靜音、切換場景和顯示來源，但沒有音量表、濾鏡、試音，監聽和音軌也只能看不能改。")}</p>
        </>
      );
      break;
    case "disabled":
      title = t("請在 {app} 開啟 WebSocket 伺服器");
      body = (
        <>
          <p>{t("這個工具透過 {app} 內建的 WebSocket 伺服器和它溝通。只要開啟一次，之後都會自動連線。")}</p>
          <ol className="guide-steps">
            {obsRunning === false && <li>{t("開啟 {app}。")}</li>}
            <li>{t("在 {app} 上方選單按 {menu}。", { menu: obsMenuPath() })}</li>
            <li>{t("勾選「啟用 WebSocket 伺服器」。「啟用驗證」保持勾選就好，密碼不用抄，這個工具會自己讀取。")}</li>
            <li>{t("按「確定」。")}</li>
          </ol>
          <p className="hint">{t("完成後這裡會自動連上，不用重開這個工具。")}</p>
          {openObs}
        </>
      );
      break;
    case "noConfig":
      title = t("找不到這台電腦上的直播軟體設定");
      body = (
        <>
          <p>{t("通常是因為這台電腦還沒開過 {app} 28 以上的版本，或用的是可攜版（設定存在程式資料夾裡）。")}</p>
          <ul className="guide-list">
            <li>{t("還沒開過 {app}：先開啟一次，再照提示開啟 WebSocket 伺服器。")}</li>
            <li>{t("可攜版的 {app}，或 {app} 在另一台電腦：用下面的「手動輸入連線資料」。")}</li>
          </ul>
          {openObs}
        </>
      );
      break;
    case "auth":
      title = t("密碼不對");
      body = failure.manual ? (
        <p>
          {t("請到 {app} 的 {menu}，按「顯示連線資訊」，複製「伺服器密碼」貼到下面。", { menu: obsMenuPath() })}
        </p>
      ) : (
        <p>
          {t("{app} 設定檔裡的密碼和 {app} 正在使用的不一樣。請到 {app} 的 {menu} 直接按「確定」，讓 {app} 重新存一次設定，這裡就會自動連上。", { menu: obsMenuPath() })}
        </p>
      );
      break;
    case "refused":
      if (obsRunning === false && !failure.manual) {
        title = t("直播軟體沒有在執行");
        body = (
          <>
            <p>{t("開啟直播軟體後這裡會自動連上。")}</p>
            {openObs}
          </>
        );
      } else {
        title = t("連不上直播軟體");
        body = (
          <>
            <p>{failure.message}</p>
            <ul className="guide-list">
              <li>{t("直播軟體剛開啟的話，等幾秒就會連上。")}</li>
              <li>
                {failure.manual
                  ? t("確認 {app} 的 {menu} 裡的連接埠，和下面填的一樣。", { menu: obsMenuPath() })
                  : t("確認 {app} 的 {menu} 裡的連接埠，和這個工具讀到的一樣。", { menu: obsMenuPath() })}
              </li>
              <li>{t("其他程式佔用了這個連接埠時，可以在 {app} 改用別的連接埠。")}</li>
            </ul>
          </>
        );
      }
      break;
    default:
      title = t("連不上直播軟體");
      body = <p>{failure.message}</p>;
  }

  return (
    <div className="guide">
      <h2>{title}</h2>
      {body}
      <p className="hint">{t("連上之前會每 3 秒自動重試。")}</p>
      <SoftwarePicker />

      {!isObs ? null : showManual ? (
        <ManualForm onCancel={failure.manual ? undefined : () => setShowManual(false)} />
      ) : (
        <button type="button" className="link" onClick={() => setShowManual(true)}>
          {t("手動輸入連線資料")}
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
      <p className="hint">{t("這些資料在 {app} 的 {menu} 按「顯示連線資訊」就看得到。", { menu: obsMenuPath() })}</p>
      <label className="field">
        <span className="field-label">{t("伺服器 IP")}</span>
        <input id="manual-host" value={host} onChange={(e) => setHost(e.target.value)} autoComplete="off" />
      </label>
      <label className="field">
        <span className="field-label">{t("連接埠")}</span>
        <input id="manual-port" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
      </label>
      <label className="field">
        <span className="field-label">{t("密碼（沒有啟用驗證就留空）")}</span>
        <input id="manual-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
      </label>
      <div className="row">
        <button type="submit" className="btn primary" disabled={!valid}>
          {t("連線")}
        </button>
        {saved ? (
          <button type="button" className="btn" onClick={useAuto}>
            {t("改回自動讀取直播軟體設定")}
          </button>
        ) : (
          onCancel && (
            <button type="button" className="btn" onClick={onCancel}>
              {t("取消")}
            </button>
          )
        )}
      </div>
    </form>
  );
}
