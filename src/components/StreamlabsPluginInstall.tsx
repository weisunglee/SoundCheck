import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { assessPlugin, usePluginFiles } from "../plugin";
import { IconButton } from "./Icon";
import { PluginUninstall } from "./PluginUninstall";
import { t } from "../i18n";
import { Step, type StepState } from "./PluginInstall";

interface InstallError {
  kind: "streamlabsRunning" | "notBundled" | "failed";
  message: string;
}

type InstallState = { kind: "idle" } | { kind: "installing" } | { kind: "done" } | { kind: "error"; error: InstallError };

interface Props {
  /** Plugin version Streamlabs has loaded right now, or null. */
  loadedVersion: string | null;
  onClose: () => void;
}

/**
 * Installs the plugin into Streamlabs' user plugin folder. A first install loads right away
 * (the app tells Streamlabs to, once the file is there); replacing a version Streamlabs has
 * loaded needs Streamlabs closed, since it keeps the file locked, and it loads the new one
 * when it starts again.
 */
export function StreamlabsPluginInstall({ loadedVersion, onClose }: Props) {
  const status = usePluginFiles("streamlabs", 1000);
  const [install, setInstall] = useState<InstallState>({ kind: "idle" });
  const [removed, setRemoved] = useState(false);
  if (!status) return null;

  const bundled = status.bundledVersion;
  const { fileCurrent, loadedCurrent, need } = assessPlugin(status, loadedVersion, true);
  const installed = install.kind === "done" || fileCurrent;
  // An older version is loaded (or the file is locked anyway): Streamlabs has to close first.
  const mustClose = (Boolean(loadedVersion) && !loadedCurrent) || (install.kind === "error" && install.error.kind === "streamlabsRunning");

  const closeStep: StepState = installed || !status.running ? "done" : "active";
  const installStep: StepState = installed ? "done" : !mustClose || closeStep === "done" ? "active" : "waiting";
  const loadStep: StepState = loadedCurrent ? "done" : installed ? "active" : "waiting";

  const run = () => {
    setInstall({ kind: "installing" });
    invoke("install_streamlabs_plugin")
      .then(() => setInstall({ kind: "done" }))
      .catch((error: InstallError) => setInstall({ kind: "error", error }));
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="plugin-title">
      <div className="dialog">
        <div className="dialog-head">
          <h2 id="plugin-title">{!status.installed ? t("安裝直播軟體外掛") : need === "update" ? t("更新直播軟體外掛") : t("直播軟體外掛")}</h2>
          <IconButton icon="x" label={t("關閉")} className="close" onClick={onClose} />
        </div>
        <p className="dialog-lead">{t("試音需要在直播軟體裡裝一個小外掛。它只會讀取直播的聲音，不會改變你的場景或設定。")}</p>

        {!bundled ? (
          <div className="verdict verdict-bad">{t("這個版本的 App 沒有附外掛，無法安裝。")}</div>
        ) : (
          <>
            <dl className="stats">
              <div>
                <dt>{t("直播軟體目前使用")}</dt>
                <dd>{loadedVersion ?? t("沒有載入")}</dd>
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

            {loadedCurrent ? (
              <div className="verdict verdict-ok">{t("外掛 {version} 已經在直播軟體裡啟用，可以使用試音了。", { version: loadedVersion ?? "" })}</div>
            ) : (
              <ol className="steps">
                {mustClose && (
                  <Step n={1} title={t("關閉直播軟體")} state={closeStep}>
                    <p className="hint">{t("直播軟體開著時，舊版外掛的檔案會被鎖住、無法更新。請你自己關閉它，這樣可以先結束直播、存好設定。關閉後這裡會自動往下一步。")}</p>
                    <div className="waiting">{t("等待直播軟體關閉…")}</div>
                  </Step>
                )}

                <Step n={mustClose ? 2 : 1} title={t("安裝外掛 {version}", { version: bundled })} state={installStep}>
                  {install.kind === "error" && install.error.kind !== "streamlabsRunning" && (
                    <div className="verdict verdict-bad">{install.error.message}</div>
                  )}
                  <button type="button" className="btn primary" disabled={install.kind === "installing" || (mustClose && status.running)} onClick={run}>
                    {install.kind === "installing" ? t("安裝中…") : install.kind === "error" ? t("再試一次") : t("安裝")}
                  </button>
                </Step>

                <Step n={mustClose ? 3 : 2} title={mustClose ? t("重新開啟直播軟體") : t("載入外掛")} state={loadStep}>
                  {!status.running ? (
                    <p className="hint">{t("直播軟體開啟時會自動載入新外掛，請開啟它。")}</p>
                  ) : mustClose && loadedVersion ? (
                    <div className="verdict verdict-warn">
                      {t("直播軟體載入的還是舊版 {version}。它可能是在安裝前就開著的，請關閉直播軟體再重新開啟。", { version: loadedVersion })}
                    </div>
                  ) : (
                    <div className="waiting">{t("等待直播軟體載入外掛…如果一直停在這裡，請關閉直播軟體再重新開啟。")}</div>
                  )}
                </Step>
              </ol>
            )}
          </>
        )}

        {(status.installed || removed) && (
          <PluginUninstall
            software="streamlabs"
            // Streamlabs keeps a loaded plugin's file locked until it closes.
            blocked={loadedVersion && status.running ? t("請先關閉直播軟體再移除。") : null}
            onRemoved={() => setRemoved(true)}
          />
        )}
      </div>
    </div>
  );
}
