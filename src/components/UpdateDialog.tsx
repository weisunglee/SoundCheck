import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { type Updater, notesSummary, openReleasePage } from "../updater";
import { Icon, IconButton } from "./Icon";
import { t } from "../i18n";

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

export function UpdateDialog({ updater }: { updater: Updater }) {
  const { state, canInstall } = updater;
  const [current, setCurrent] = useState("");
  useEffect(() => {
    getVersion()
      .then(setCurrent)
      .catch(() => {});
  }, []);

  const update = "update" in state ? state.update : null;
  const working = state.kind === "downloading" || state.kind === "installing";
  const notes = notesSummary(update?.body);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="update-title">
      <div className="dialog">
        <div className="dialog-head">
          <h2 id="update-title">{update ? t("SoundCheck 有新版本") : t("檢查更新")}</h2>
          {!working && <IconButton icon="x" label={t("關閉")} className="close" onClick={updater.later} />}
        </div>

        {state.kind === "checking" && <p className="dialog-lead">{t("正在檢查更新…")}</p>}
        {state.kind === "upToDate" && <div className="verdict verdict-ok">{t("你用的已經是最新版 {version}。", { version: current })}</div>}
        {state.kind === "error" && !update && (
          <>
            <div className="verdict verdict-bad">{t("沒有辦法檢查更新：{error}", { error: state.message })}</div>
            <div className="row">
              <button type="button" className="btn primary" onClick={updater.checkNow}>
                {t("再試一次")}
              </button>
              <button type="button" className="btn" onClick={() => openReleasePage()}>
                <Icon name="external-link" size={15} />
                {t("開啟下載頁")}
              </button>
            </div>
          </>
        )}

        {update && (
          <>
            <p className="dialog-lead">
              {t("SoundCheck {version} 已經推出，你現在用的是 {current}。", { version: update.version, current: update.currentVersion })}
            </p>
            {notes && <div className="update-notes">{notes}</div>}
            <button type="button" className="link update-page" onClick={() => openReleasePage(update.version)}>
              {t("在 GitHub 查看完整說明")}
            </button>

            {state.kind === "downloading" && (
              <div className="dialog-body">
                <div className="progress">
                  <b style={{ width: state.total ? `${(state.received / state.total) * 100}%` : "0%" }} />
                </div>
                <p className="hint">
                  {state.total
                    ? t("正在下載 {received} / {total} MB…", { received: mb(state.received), total: mb(state.total) })
                    : t("正在下載 {received} MB…", { received: mb(state.received) })}
                </p>
              </div>
            )}
            {state.kind === "installing" && <div className="waiting">{t("正在安裝，完成後 SoundCheck 會自動重新開啟…")}</div>}
            {state.kind === "error" && <div className="verdict verdict-bad">{t("更新失敗：{error}", { error: state.message })}</div>}

            {!working && (
              <>
                <p className="hint">
                  {canInstall
                    ? t("更新時 SoundCheck 會關閉再重新開啟，直播軟體不受影響。")
                    : t("這個版本沒辦法自動更新（例如免安裝版），請到下載頁下載新版。")}
                </p>
                <div className="row">
                  {canInstall ? (
                    <button type="button" className="btn primary" onClick={updater.install}>
                      <Icon name="download" size={15} />
                      {state.kind === "error" ? t("再試一次") : t("更新")}
                    </button>
                  ) : (
                    <button type="button" className="btn primary" onClick={() => openReleasePage(update.version)}>
                      <Icon name="external-link" size={15} />
                      {t("開啟下載頁")}
                    </button>
                  )}
                  <button type="button" className="btn" onClick={updater.later}>
                    {t("以後再說")}
                  </button>
                  <button type="button" className="btn" onClick={updater.skip}>
                    {t("略過這個版本")}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
