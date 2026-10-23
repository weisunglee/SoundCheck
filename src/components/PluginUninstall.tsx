import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import type { SoftwareId } from "../software";
import { Icon } from "./Icon";
import { t } from "../i18n";

interface UninstallError {
  kind: "obsRunning" | "streamlabsRunning" | "permissionDenied" | "cancelled" | "failed";
  message: string;
}

type State = { kind: "idle" } | { kind: "confirm" } | { kind: "removing" } | { kind: "done" } | { kind: "error"; error: UninstallError };

interface Props {
  software: SoftwareId;
  /** Why removing can't start right now (the software has the plugin loaded), or null. */
  blocked: string | null;
  onRemoved: () => void;
}

const COMMANDS: Record<SoftwareId, string> = { obs: "uninstall_plugin", streamlabs: "uninstall_streamlabs_plugin" };

/** The bottom of an install dialog: removing the plugin, after a confirmation. */
export function PluginUninstall({ software, blocked, onRemoved }: Props) {
  const [state, setState] = useState<State>({ kind: "idle" });

  const run = (command: string) => {
    setState({ kind: "removing" });
    invoke(command)
      .then(() => {
        setState({ kind: "done" });
        onRemoved();
      })
      .catch((error: UninstallError) => setState({ kind: "error", error }));
  };

  if (state.kind === "done") return <div className="verdict verdict-ok">{t("已移除外掛。")}</div>;

  return (
    <section className="uninstall">
      <h4 className="section-title">{t("移除外掛")}</h4>
      <p className="hint">{t("移除後就不能用試音和直播音量表，之後可以隨時再安裝。")}</p>
      {blocked && <p className="hint">{blocked}</p>}
      {state.kind === "error" && <div className="verdict verdict-bad">{state.error.message}</div>}
      {state.kind === "error" && state.error.kind === "permissionDenied" ? (
        <>
          <p className="hint">{t("按下面的按鈕後，Windows 會跳出視窗詢問是否允許，請按「是」。")}</p>
          <button type="button" className="btn danger" onClick={() => run("uninstall_plugin_elevated")}>
            {t("用系統管理員權限移除")}
          </button>
        </>
      ) : state.kind === "confirm" ? (
        <div className="row">
          <button type="button" className="btn danger" onClick={() => run(COMMANDS[software])}>
            {t("確定移除")}
          </button>
          <button type="button" className="btn" onClick={() => setState({ kind: "idle" })}>
            {t("取消")}
          </button>
        </div>
      ) : (
        <button type="button" className="btn danger" disabled={Boolean(blocked) || state.kind === "removing"} onClick={() => setState({ kind: "confirm" })}>
          <Icon name="trash-2" size={15} />
          {state.kind === "removing" ? t("移除中…") : t("移除外掛")}
        </button>
      )}
    </section>
  );
}
