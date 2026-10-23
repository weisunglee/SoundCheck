import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import type { SoftwareAdapter } from "../adapter";
import { type ApplyResult, BACKUPS_KEPT, type Profile, applyProfile, backupName, captureProfile } from "../profiles";
import type { AudioSource } from "../types";
import { locale, t } from "../i18n";

interface Summary {
  name: string;
  savedAt: string | null;
  sourceCount: number;
  backup: boolean;
}

interface Props {
  adapter: SoftwareAdapter;
  sources: AudioSource[];
  onClose: () => void;
}

type Busy = { kind: "idle" } | { kind: "working"; label: string } | { kind: "error"; message: string };

const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale(), { dateStyle: "short", timeStyle: "short" }) : "");

export function ProfilesDialog({ adapter, sources, onClose }: Props) {
  const [list, setList] = useState<Summary[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<Busy>({ kind: "idle" });
  const [confirm, setConfirm] = useState<{ kind: "apply" | "delete" | "overwrite"; name: string; otherCollection?: string | null } | null>(null);
  const [result, setResult] = useState<{ name: string; result: ApplyResult } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const refresh = useCallback(
    () =>
      invoke<Summary[]>("profiles_list")
        .then(setList)
        .catch((e: string) => setBusy({ kind: "error", message: e })),
    [],
  );
  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = async (label: string, task: () => Promise<void>) => {
    setBusy({ kind: "working", label });
    setConfirm(null);
    try {
      await task();
      setBusy({ kind: "idle" });
    } catch (e) {
      setBusy({ kind: "error", message: String((e as Error).message ?? e) });
    }
    refresh();
  };

  const save = (profileName: string) =>
    run(t("儲存中…"), async () => {
      const profile = await captureProfile(adapter, profileName, sources);
      await invoke("profile_save", { name: profileName, data: profile });
      setSaved(profileName);
      setName("");
    });

  const apply = (profileName: string) =>
    run(t("套用中…"), async () => {
      const profile = await invoke<Profile>("profile_load", { name: profileName });
      // Keep the current settings first, so a wrong profile can be undone; keep only the newest few.
      const backup = backupName();
      await invoke("profile_save", { name: backup, data: await captureProfile(adapter, backup, sources, true) });
      const backups = (await invoke<Summary[]>("profiles_list")).filter((p) => p.backup);
      for (const old of backups.slice(BACKUPS_KEPT)) await invoke("profile_delete", { name: old.name });
      setResult({ name: profileName, result: await applyProfile(adapter, profile, sources) });
    });

  const askApply = async (profileName: string) => {
    const [profile, collection] = await Promise.all([
      invoke<Profile>("profile_load", { name: profileName }).catch(() => null),
      adapter.sceneCollection?.().catch(() => null) ?? null,
    ]);
    const current = collection;
    const otherCollection = profile?.sceneCollection && current && profile.sceneCollection !== current ? profile.sceneCollection : null;
    setConfirm({ kind: "apply", name: profileName, otherCollection });
  };

  const remove = (profileName: string) => run(t("刪除中…"), () => invoke("profile_delete", { name: profileName }));

  const trimmed = name.trim();
  const exists = list?.some((p) => p.name === trimmed) ?? false;
  const working = busy.kind === "working";

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="profiles-title">
      <div className="dialog wide">
        <div className="dialog-head">
          <h2 id="profiles-title">{t("聲音設定檔")}</h2>
          <button type="button" className="link" onClick={onClose}>
            {t("關閉")}
          </button>
        </div>
        <p className="dialog-lead">
          {t("把所有聲音來源的音量、靜音、監聽、左右平衡、提早延後、音軌和聲音濾鏡存成一組，之後一鍵套用。套用前會自動備份目前的設定（保留最近 {n} 份），套錯可以還原。", { n: BACKUPS_KEPT })}
        </p>

        <form
          className="row save-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!trimmed || working) return;
            if (exists) setConfirm({ kind: "overwrite", name: trimmed });
            else save(trimmed);
          }}
        >
          <input
            id="profile-name"
            className="text-input"
            placeholder={t("例如：直播用、錄 Podcast")}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="btn primary" disabled={!trimmed || working}>
            {t("儲存目前的設定")}
          </button>
        </form>

        {confirm && (
          <div className="verdict verdict-warn confirm">
            {confirm.kind === "apply" && t("套用「{name}」會改變直播軟體裡的聲音設定（會先自動備份）。確定嗎？", { name: confirm.name })}
            {confirm.kind === "apply" && confirm.otherCollection && (
              <div>{t("注意：這個設定檔是在場景集合「{collection}」存的，同名的來源在這裡可能是不同的東西。", { collection: confirm.otherCollection })}</div>
            )}
            {confirm.kind === "delete" && t("刪除「{name}」？刪除後無法復原。", { name: confirm.name })}
            {confirm.kind === "overwrite" && t("已經有「{name}」，要用目前的設定覆蓋嗎？", { name: confirm.name })}
            <div className="row">
              <button
                type="button"
                className="btn primary"
                onClick={() => (confirm.kind === "apply" ? apply(confirm.name) : confirm.kind === "delete" ? remove(confirm.name) : save(confirm.name))}
              >
                {t("確定")}
              </button>
              <button type="button" className="btn" onClick={() => setConfirm(null)}>
                {t("取消")}
              </button>
            </div>
          </div>
        )}

        {busy.kind === "working" && <p className="hint">{busy.label}</p>}
        {busy.kind === "error" && <div className="verdict verdict-bad">{busy.message}</div>}
        {saved && busy.kind === "idle" && !result && <div className="verdict verdict-ok">{t("已經存成「{name}」。", { name: saved })}</div>}
        {result && <ApplySummary name={result.name} result={result.result} />}

        <section className="wizard-section">
          <h4 className="section-title">{t("已儲存的設定檔")}</h4>
          {!list ? (
            <p className="hint">{t("讀取中…")}</p>
          ) : list.length === 0 ? (
            <p className="hint">{t("還沒有設定檔。調好聲音後，在上面取個名字儲存。")}</p>
          ) : (
            <ul className="elsewhere">
              {list.map((p) => (
                <li key={p.name}>
                  <div>
                    <div className="src-name">{p.name}</div>
                    <div className="dev">
                      {t("{time}・{n} 個來源", { time: fmtTime(p.savedAt), n: p.sourceCount })}
                    </div>
                  </div>
                  <div className="row">
                    <button type="button" className="btn small" disabled={working} onClick={() => askApply(p.name)}>
                      {t("套用")}
                    </button>
                    <button type="button" className="btn small" disabled={working} onClick={() => setConfirm({ kind: "delete", name: p.name })}>
                      {t("刪除")}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function ApplySummary({ name, result }: { name: string; result: ApplyResult }) {
  return (
    <div className={`verdict ${result.errors.length > 0 ? "verdict-warn" : "verdict-ok"}`}>
      <div>
        {t("已套用「{name}」到 {n} 個來源。", { name, n: result.applied.length })}
      </div>
      {result.missing.length > 0 && <div>{t("直播軟體裡找不到、已略過：{list}", { list: result.missing.join(t("、")) })}</div>}
      {result.extraFilters.length > 0 && <div>{t("設定檔裡沒有、保留不動的濾鏡：{list}", { list: result.extraFilters.join(t("、")) })}</div>}
      {result.errors.map((e) => (
        <div key={e}>{e}</div>
      ))}
    </div>
  );
}
