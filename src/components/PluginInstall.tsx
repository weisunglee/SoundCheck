import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { outputsActive } from "../obsAdapter";
import { assessPlugin, usePluginFiles } from "../plugin";
import { IconButton } from "./Icon";
import { t } from "../i18n";

interface InstallError {
  kind: "obsRunning" | "permissionDenied" | "notBundled" | "cancelled" | "failed";
  message: string;
}

const logEvent = (message: string) => invoke("log_install_event", { message }).catch(() => {});

type InstallState = { kind: "idle" } | { kind: "installing" } | { kind: "done" } | { kind: "error"; error: InstallError };

interface Props {
  obsConnected: boolean;
  /** Plugin version OBS has loaded right now, or null. */
  loadedVersion: string | null;
  onClose: () => void;
}

export type StepState = "done" | "active" | "waiting";

export function Step({ n, title, state, children }: { n: number; title: string; state: StepState; children?: React.ReactNode }) {
  return (
    <li className={`step step-${state}`}>
      <span className="step-n">{state === "done" ? "✓" : n}</span>
      <div className="step-body">
        <div className="step-title">{title}</div>
        {state === "active" && children}
      </div>
    </li>
  );
}

/** Polls whether OBS is streaming or recording, so we can warn before the user closes it. */
function useOutputsActive(enabled: boolean) {
  const [active, setActive] = useState({ streaming: false, recording: false });
  useEffect(() => {
    if (!enabled) return;
    const poll = () =>
      outputsActive()
        .then(setActive)
        .catch(() => {});
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, [enabled]);
  return enabled ? active : { streaming: false, recording: false };
}

export function PluginInstall({ obsConnected, loadedVersion, onClose }: Props) {
  const status = usePluginFiles("obs", 1000);
  const [install, setInstall] = useState<InstallState>({ kind: "idle" });
  const [launching, setLaunching] = useState<string | null>(null);
  const outputs = useOutputsActive(obsConnected);
  const lastLogged = useRef("");

  const bundled = status?.bundledVersion ?? null;
  const { fileCurrent, loadedCurrent } = status ? assessPlugin(status, loadedVersion, obsConnected) : { fileCurrent: false, loadedCurrent: false };
  const installed = install.kind === "done" || fileCurrent;
  const finished = installed && loadedCurrent;

  const closeStep: StepState = installed || !status?.running ? "done" : "active";
  const installStep: StepState = installed ? "done" : closeStep === "done" ? "active" : "waiting";
  const openStep: StepState = finished ? "done" : installed ? "active" : "waiting";

  // Record every change in what the dialog shows, so a failed install can be traced from install.log.
  useEffect(() => {
    if (!status) return;
    const snapshot =
      `steps close=${closeStep} install=${installStep} open=${openStep} finished=${finished} | ` +
      `obsRunning=${status.running} connected=${obsConnected} loaded=${loadedVersion} ` +
      `file=${status.installed ? (status.installedVersion ?? "unknown") : "none"} bundled=${bundled} ` +
      `pluginManager=${status.enabledInPluginManager} install=${install.kind}` +
      (install.kind === "error" ? ` (${install.error.kind}: ${install.error.message})` : "");
    if (snapshot !== lastLogged.current) {
      lastLogged.current = snapshot;
      logEvent(snapshot);
    }
  });

  if (!status) return null;

  const run = (command: "install_plugin" | "install_plugin_elevated") => {
    logEvent(`clicked ${command}`);
    setInstall({ kind: "installing" });
    invoke(command)
      .then(() => setInstall({ kind: "done" }))
      .catch((error: InstallError) => setInstall({ kind: "error", error }));
  };

  const launch = () => {
    logEvent("clicked launch_obs");
    setLaunching(null);
    invoke("launch_obs").catch((e: string) => setLaunching(e));
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="plugin-title">
      <div className="dialog">
        <div className="dialog-head">
          <h2 id="plugin-title">{status.installed ? t("更新直播軟體外掛") : t("安裝直播軟體外掛")}</h2>
          <IconButton icon="x" label={t("關閉")} className="close" onClick={() => (logEvent("closed dialog"), onClose())} />
        </div>
        <p className="dialog-lead">
          {t("試音需要在直播軟體裡裝一個小外掛。它只會讀取直播的聲音，不會改變你的場景或設定。")}
        </p>

        {!bundled ? (
          <div className="verdict verdict-bad">{t("這個版本的 App 沒有附外掛，無法安裝。")}</div>
        ) : (
          <>
            <dl className="stats">
              <div>
                <dt>{t("直播軟體目前使用")}</dt>
                <dd>{loadedVersion ?? (obsConnected ? t("沒有載入") : "—")}</dd>
              </div>
              <div>
                <dt>{t("已安裝的檔案")}</dt>
                <dd>{status.installed ? (status.installedVersion ?? t("版本不明")) : t("沒有安裝")}</dd>
              </div>
              <div>
                <dt>{t("新版本")}</dt>
                <dd>{bundled}</dd>
              </div>
            </dl>

            {finished ? (
              <div className="verdict verdict-ok">{t("外掛 {version} 已經在直播軟體裡啟用，可以使用試音了。", { version: loadedVersion ?? "" })}</div>
            ) : (
              <ol className="steps">
                <Step n={1} title={t("關閉直播軟體")} state={closeStep}>
                  <p className="hint">{t("安裝外掛時直播軟體必須關閉。請你自己關閉它，這樣可以先結束直播、存好設定。關閉後這裡會自動往下一步。")}</p>
                  {(outputs.streaming || outputs.recording) && (
                    <div className="verdict verdict-bad">
                      {t("直播軟體正在{what}，請先結束再關閉直播軟體。", {
                        what: outputs.streaming && outputs.recording ? t("直播和錄影") : outputs.streaming ? t("直播") : t("錄影"),
                      })}
                    </div>
                  )}
                  <div className="waiting">{t("等待直播軟體關閉…")}</div>
                </Step>

                <Step n={2} title={t("安裝外掛 {version}", { version: bundled })} state={installStep}>
                  {status.legacyInstalled && <p className="hint">{t("這次會一併移除改名前的舊版外掛（obs-audio-kit）。")}</p>}
                  {install.kind === "error" && install.error.kind === "permissionDenied" ? (
                    <>
                      <div className="verdict verdict-warn">{install.error.message}</div>
                      <p className="hint">{t("按下面的按鈕後，Windows 會跳出視窗詢問是否允許，請按「是」。")}</p>
                      <button type="button" className="btn primary" onClick={() => run("install_plugin_elevated")}>
                        {t("用系統管理員權限安裝")}
                      </button>
                    </>
                  ) : (
                    <>
                      {install.kind === "error" && <div className="verdict verdict-bad">{install.error.message}</div>}
                      <button
                        type="button"
                        className="btn primary"
                        disabled={install.kind === "installing" || status.running}
                        onClick={() => run("install_plugin")}
                      >
                        {install.kind === "installing" ? t("安裝中…") : install.kind === "error" ? t("再試一次") : t("安裝")}
                      </button>
                    </>
                  )}
                </Step>

                <Step n={3} title={t("重新開啟直播軟體")} state={openStep}>
                  {!status.running ? (
                    <>
                      <p className="hint">{t("直播軟體開啟時才會載入新外掛。")}</p>
                      <button type="button" className="btn primary" onClick={launch}>
                        {t("開啟直播軟體")}
                      </button>
                      {launching && <div className="verdict verdict-bad">{t("{error}，請自己開啟直播軟體。", { error: launching })}</div>}
                    </>
                  ) : !obsConnected ? (
                    <div className="waiting">{t("直播軟體啟動中，等待連線…")}</div>
                  ) : loadedVersion ? (
                    <div className="verdict verdict-warn">
                      {t("直播軟體載入的還是舊版 {version}。它可能是在安裝前就開著的，請關閉直播軟體再重新開啟。", { version: loadedVersion })}
                    </div>
                  ) : status.enabledInPluginManager === false ? (
                    <div className="verdict verdict-warn">
                      {t("外掛在 {app} 裡被停用了。請到 {app} 的「工具 → 外掛程式管理員」勾選 SoundCheck，再重新開啟 {app}。")}
                    </div>
                  ) : (
                    <div className="waiting">{t("等待直播軟體載入外掛…如果一直停在這裡，請關閉直播軟體再重新開啟。")}</div>
                  )}
                </Step>
              </ol>
            )}
          </>
        )}
      </div>
    </div>
  );
}
