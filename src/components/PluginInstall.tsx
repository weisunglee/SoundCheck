import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { obs } from "../obs";
import { compareVersions, usePluginStatus } from "../pluginStatus";

interface InstallError {
  kind: "obsRunning" | "permissionDenied" | "notBundled" | "cancelled" | "failed";
  message: string;
}

type InstallState = { kind: "idle" } | { kind: "installing" } | { kind: "done" } | { kind: "error"; error: InstallError };

interface Props {
  obsConnected: boolean;
  /** Plugin version OBS has loaded right now, or null. */
  loadedVersion: string | null;
  onClose: () => void;
}

type StepState = "done" | "active" | "waiting";

function Step({ n, title, state, children }: { n: number; title: string; state: StepState; children?: React.ReactNode }) {
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
      Promise.all([obs.call("GetStreamStatus"), obs.call("GetRecordStatus")])
        .then(([s, r]) => setActive({ streaming: s.outputActive, recording: r.outputActive }))
        .catch(() => {});
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, [enabled]);
  return enabled ? active : { streaming: false, recording: false };
}

export function PluginInstall({ obsConnected, loadedVersion, onClose }: Props) {
  const status = usePluginStatus(1000);
  const [install, setInstall] = useState<InstallState>({ kind: "idle" });
  const [launching, setLaunching] = useState<string | null>(null);
  const outputs = useOutputsActive(obsConnected);

  if (!status) return null;
  const bundled = status.bundledVersion;

  const run = (command: "install_plugin" | "install_plugin_elevated") => {
    setInstall({ kind: "installing" });
    invoke(command)
      .then(() => setInstall({ kind: "done" }))
      .catch((error: InstallError) => setInstall({ kind: "error", error }));
  };

  const launch = () => {
    setLaunching(null);
    invoke("launch_obs").catch((e: string) => setLaunching(e));
  };

  const fileCurrent = Boolean(bundled && status.installedVersion && compareVersions(status.installedVersion, bundled) >= 0);
  const installed = install.kind === "done" || fileCurrent;
  const loadedCurrent = Boolean(bundled && loadedVersion && compareVersions(loadedVersion, bundled) >= 0);
  const finished = installed && loadedCurrent;

  const closeStep: StepState = installed || !status.obsRunning ? "done" : "active";
  const installStep: StepState = installed ? "done" : closeStep === "done" ? "active" : "waiting";
  const openStep: StepState = finished ? "done" : installed ? "active" : "waiting";

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="plugin-title">
      <div className="dialog">
        <div className="dialog-head">
          <h2 id="plugin-title">{status.installed ? "更新 OBS 外掛" : "安裝 OBS 外掛"}</h2>
          <button type="button" className="link" onClick={onClose}>
            關閉
          </button>
        </div>
        <p className="dialog-lead">
          試音需要在 OBS 裡裝一個小外掛 obs-audio-kit。它只會讀取直播的聲音，不會改變你的場景或設定。
        </p>

        {!bundled ? (
          <div className="verdict verdict-bad">這個版本的 App 沒有附外掛，無法安裝。</div>
        ) : (
          <>
            <dl className="stats">
              <div>
                <dt>OBS 目前使用</dt>
                <dd>{loadedVersion ?? (obsConnected ? "沒有載入" : "—")}</dd>
              </div>
              <div>
                <dt>已安裝的檔案</dt>
                <dd>{status.installed ? (status.installedVersion ?? "版本不明") : "沒有安裝"}</dd>
              </div>
              <div>
                <dt>新版本</dt>
                <dd>{bundled}</dd>
              </div>
            </dl>

            {finished ? (
              <div className="verdict verdict-ok">外掛 {loadedVersion} 已經在 OBS 裡啟用，可以使用試音了。</div>
            ) : (
              <ol className="steps">
                <Step n={1} title="關閉 OBS" state={closeStep}>
                  <p className="hint">安裝外掛時 OBS 必須關閉。請你自己關閉 OBS，這樣可以先結束直播、存好設定。關閉後這裡會自動往下一步。</p>
                  {(outputs.streaming || outputs.recording) && (
                    <div className="verdict verdict-bad">
                      OBS 正在{outputs.streaming && outputs.recording ? "直播和錄影" : outputs.streaming ? "直播" : "錄影"}，請先結束再關閉 OBS。
                    </div>
                  )}
                  <div className="waiting">等待 OBS 關閉…</div>
                </Step>

                <Step n={2} title={`安裝外掛 ${bundled}`} state={installStep}>
                  {install.kind === "error" && install.error.kind === "permissionDenied" ? (
                    <>
                      <div className="verdict verdict-warn">{install.error.message}</div>
                      <p className="hint">按下面的按鈕後，Windows 會跳出視窗詢問是否允許，請按「是」。</p>
                      <button type="button" className="btn primary" onClick={() => run("install_plugin_elevated")}>
                        用系統管理員權限安裝
                      </button>
                    </>
                  ) : (
                    <>
                      {install.kind === "error" && <div className="verdict verdict-bad">{install.error.message}</div>}
                      <button
                        type="button"
                        className="btn primary"
                        disabled={install.kind === "installing" || status.obsRunning}
                        onClick={() => run("install_plugin")}
                      >
                        {install.kind === "installing" ? "安裝中…" : install.kind === "error" ? "再試一次" : "安裝"}
                      </button>
                    </>
                  )}
                </Step>

                <Step n={3} title="重新開啟 OBS" state={openStep}>
                  {!status.obsRunning ? (
                    <>
                      <p className="hint">OBS 開啟時才會載入新外掛。</p>
                      <button type="button" className="btn primary" onClick={launch}>
                        開啟 OBS
                      </button>
                      {launching && <div className="verdict verdict-bad">{launching}，請自己開啟 OBS。</div>}
                    </>
                  ) : !obsConnected ? (
                    <div className="waiting">OBS 啟動中，等待連線…</div>
                  ) : loadedVersion ? (
                    <div className="verdict verdict-warn">
                      OBS 載入的還是舊版 {loadedVersion}。OBS 可能是在安裝前就開著的，請關閉 OBS 再重新開啟。
                    </div>
                  ) : status.enabledInPluginManager === false ? (
                    <div className="verdict verdict-warn">
                      外掛在 OBS 裡被停用了。請到 OBS 的「工具 → 外掛程式管理員」勾選 obs-audio-kit，再重新開啟 OBS。
                    </div>
                  ) : (
                    <div className="waiting">等待 OBS 載入外掛…如果一直停在這裡，請關閉 OBS 再重新開啟。</div>
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
