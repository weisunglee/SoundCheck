import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { FilterOps, SoftwareAdapter } from "../adapter";
import { t } from "../i18n";
import { meterPosition } from "../levels";
import { type Plugin, VOICE_PLUGIN_VERSION, compareVersions } from "../plugin";
import { captureBackup, storeBackup } from "../profiles";
import type { AudioSource, MonitorType } from "../types";
import {
  type Applied,
  type VoiceAnalysis,
  addAnalyzer,
  applyPlan,
  compare,
  describePlan,
  finish,
  isNoiseSuppression,
  issueText,
  removeAnalyzers,
  undo,
} from "../voiceTuning";
import { Icon, IconButton } from "./Icon";
import { meterFill } from "./LevelMeter";
import { SpectrumChart } from "./SpectrumChart";

const DURATIONS = [15, 20];
const POLL_MS = 250;
/** With nothing recorded after this long, the analyzer isn't getting audio. */
const NO_AUDIO_MS = 3000;

type Phase =
  | { kind: "intro" }
  | { kind: "recording"; elapsed: number; peak: number }
  | { kind: "analyzing" }
  /**
   * `applied` is the tuned chain put in place for listening (the filters it replaces only turned
   * off) once the user first switches to it; `tuned` says which of the two is playing.
   */
  | { kind: "result"; analysis: VoiceAnalysis; hasNoiseSuppression: boolean; applied: Applied | null; tuned: boolean }
  | { kind: "done" }
  | { kind: "error"; message: string };

interface Props {
  adapter: SoftwareAdapter;
  ops: FilterOps;
  source: AudioSource;
  plugin: Plugin | null;
  /** What the plugin reports: undefined while asking, null when it isn't loaded. */
  pluginVersion: string | null | undefined;
  /** The plugin can be installed from here (the software runs on this computer). */
  canInstall: boolean;
  onInstallPlugin: () => void;
  /** Sets the source's monitoring; missing where the software can't. */
  onMonitorType?: (type: MonitorType) => void;
  onClose: () => void;
}

type Result = Extract<Phase, { kind: "result" }>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const message = (e: unknown) => String((e as Error)?.message ?? e);

export function VoiceTuning({ adapter, ops, source, plugin, pluginVersion, canInstall, onInstallPlugin, onMonitorType, onClose }: Props) {
  const name = source.name;
  const [seconds, setSeconds] = useState(15);
  const [phase, setPhase] = useState<Phase>({ kind: "intro" });
  const [busy, setBusy] = useState(false);
  /** A change the software rejected; the phase stays, so compare and undo still work. */
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef(false);
  const recordingRef = useRef(false);
  /** The chain being listened to and not applied yet: closing or recording again takes it off. */
  const previewRef = useRef<Applied | null>(null);
  /** The source as it was before listening, saved as a backup profile only if the user applies. */
  const backupRef = useRef<Awaited<ReturnType<typeof captureBackup>> | null>(null);

  // Listening from the dialog turns on monitoring that keeps the stream as it is; closing the
  // dialog puts back the monitoring the source had when it opened.
  const monitorRef = useRef({ original: source.monitorType, current: source.monitorType, set: onMonitorType });
  monitorRef.current.current = source.monitorType;
  monitorRef.current.set = onMonitorType;
  useEffect(
    () => () => {
      const m = monitorRef.current;
      if (m.current !== m.original) m.set?.(m.original);
    },
    [],
  );
  const listening = source.monitorType !== "off";

  // Closing mid-recording still takes the analyzer off the source, and closing without applying
  // puts back the filters the source had.
  useEffect(
    () => () => {
      stopRef.current = true;
      if (recordingRef.current) {
        plugin?.stopVoiceCapture(name).catch(() => {});
        removeAnalyzers(ops, name).catch(() => {});
      }
      if (previewRef.current) undo(ops, name, previewRef.current).catch(() => {});
    },
    [ops, plugin, name],
  );

  const ready = plugin && pluginVersion && compareVersions(pluginVersion, VOICE_PLUGIN_VERSION) >= 0;

  const record = async () => {
    if (!plugin) return;
    // The recording has to hear the mic as it was, so a chain being listened to comes off first.
    if (previewRef.current) {
      try {
        await undo(ops, name, previewRef.current);
        previewRef.current = null;
      } catch (e) {
        setError(t("直播軟體沒有接受這個變更：{error}", { error: message(e) }));
        return;
      }
    }
    stopRef.current = false;
    recordingRef.current = true;
    setError(null);
    setPhase({ kind: "recording", elapsed: 0, peak: 0 });
    try {
      await addAnalyzer(ops, name);
      const { sampleRate } = await plugin.startVoiceCapture(name, seconds);
      const chunks: string[] = [];
      let from = 0;
      const started = performance.now();
      for (;;) {
        await sleep(POLL_MS);
        const early = stopRef.current;
        const chunk = await plugin.readVoiceCapture(name, from);
        if (chunk.frames > 0) {
          chunks.push(chunk.data);
          from += chunk.frames;
        }
        if (!early && stopRef.current) return; // Closed while reading.
        setPhase({ kind: "recording", elapsed: from / sampleRate, peak: chunk.peak });
        if (chunk.total === 0 && performance.now() - started > NO_AUDIO_MS) {
          throw new Error(t("錄音時沒有收到任何聲音。這個來源可能沒有在運作，或麥克風沒有接上。"));
        }
        // Stopped early: take what is there, then stop.
        if (early && chunk.frames === 0) break;
        if (!chunk.capturing && from >= chunk.total) break;
      }
      await plugin.stopVoiceCapture(name);
      await removeAnalyzers(ops, name);
      recordingRef.current = false;

      setPhase({ kind: "analyzing" });
      const analysis = await invoke<VoiceAnalysis>("voice_analyze", { chunks, sampleRate });
      const hasNoiseSuppression = (await ops.list(name)).some((f) => isNoiseSuppression(f.kind) && f.enabled);
      setPhase({ kind: "result", analysis, hasNoiseSuppression, applied: null, tuned: false });
    } catch (e) {
      setPhase({ kind: "error", message: message(e) });
    } finally {
      if (recordingRef.current) {
        recordingRef.current = false;
        await plugin.stopVoiceCapture(name).catch(() => {});
        await removeAnalyzers(ops, name).catch(() => {});
      }
    }
  };

  const run = async (step: () => Promise<void>, onFail?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await step();
    } catch (e) {
      setError(t("直播軟體沒有接受這個變更：{error}", { error: message(e) }));
      onFail?.();
    } finally {
      setBusy(false);
    }
  };

  /** Puts the tuned chain in place the first time, after capturing the source as it is. */
  const tune = async (p: Result): Promise<Applied> => {
    if (p.applied) return p.applied;
    if (!p.analysis.plan) throw new Error("no plan");
    backupRef.current = await captureBackup(adapter, [source]);
    const applied = await applyPlan(ops, name, p.analysis.plan);
    // applyPlan puts things back itself when a step fails.
    previewRef.current = applied;
    return applied;
  };

  /** Listens to the tuned chain or to the original; nothing is kept until "Apply". */
  const listenTo = (p: Result, tuned: boolean) =>
    run(async () => {
      if (!p.applied && !tuned) return;
      const applied = await tune(p);
      if (p.applied) await compare(ops, name, applied, tuned);
      setPhase({ ...p, applied, tuned });
    });

  const apply = (p: Result) =>
    run(async () => {
      const applied = await tune(p);
      // A backup the user can still apply from Profiles; only applying makes one.
      if (backupRef.current) await storeBackup(backupRef.current);
      await finish(ops, name, applied);
      previewRef.current = null;
      setPhase({ kind: "done" });
    });

  const close = () => {
    if (phase.kind === "recording") stopRef.current = true;
    onClose();
  };

  const result = phase.kind === "result" ? phase : null;
  const blocking = result?.analysis.issues.filter((i) => i.blocking) ?? [];
  const notes = result?.analysis.issues.filter((i) => !i.blocking && i.kind !== "someNoise") ?? [];

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="voice-title">
      <div className="dialog dialog-wide">
        <div className="dialog-head">
          <h2 id="voice-title">{t("自動調整人聲：{source}", { source: name })}</h2>
          <IconButton icon="x" label={t("關閉")} className="close" onClick={close} />
        </div>

        {error && <div className="verdict verdict-bad">{error}</div>}

        {phase.kind === "intro" && (
          <div className="dialog-body">
            <p className="dialog-lead">
              {t("錄一段你說話的聲音，分析你的聲線，再自動設定濾鏡：切掉低頻雜音、讓聲音不悶、字更清楚，音量也調到剛好。套用前可以先切換試聽；套用時會先備份目前的濾鏡。")}
            </p>
            {pluginVersion === undefined ? (
              <p className="hint">{t("正在檢查外掛…")}</p>
            ) : !ready ? (
              <>
                <div className="verdict verdict-warn">
                  {pluginVersion
                    ? t("自動調整人聲需要 {need} 以上的 SoundCheck 外掛，直播軟體目前載入的是 {version}。", { need: VOICE_PLUGIN_VERSION, version: pluginVersion })
                    : t("自動調整人聲需要 SoundCheck 外掛，直播軟體目前沒有載入它。")}
                </div>
                {canInstall ? (
                  <button type="button" className="btn primary" onClick={onInstallPlugin}>
                    <Icon name="download" size={15} />
                    {pluginVersion ? t("更新外掛") : t("安裝外掛")}
                  </button>
                ) : (
                  <p className="hint">{t("直播軟體在另一台電腦上，請在那台電腦安裝或更新外掛。")}</p>
                )}
              </>
            ) : (
              <>
                <div className="row-label">{t("錄音長度")}</div>
                <div className="seg seg-inline" role="group" aria-label={t("錄音長度")}>
                  {DURATIONS.map((d) => (
                    <button key={d} type="button" aria-pressed={seconds === d} onClick={() => setSeconds(d)}>
                      {t("{n} 秒", { n: d })}
                    </button>
                  ))}
                </div>
                <p className="hint">
                  {t("在平常直播的位置，用平常的音量像直播時一樣說話，例如念一段文章或介紹今天要玩什麼，有自然的停頓沒關係。錄的是麥克風本身的聲音，不會經過現有的濾鏡，觀眾也不會聽到任何變化。")}
                </p>
                <button type="button" className="btn primary" onClick={record}>
                  <Icon name="mic" size={15} />
                  {t("開始錄音")}
                </button>
              </>
            )}
          </div>
        )}

        {phase.kind === "recording" && (
          <div className="dialog-body">
            <div className="rec-status">
              <span className="rec-dot" />
              {t("錄音中 {elapsed} / {total} 秒", { elapsed: phase.elapsed.toFixed(1), total: seconds })}
            </div>
            <div className="hmeters">
              <div className="hmeter">
                <b style={meterFill(meterPosition(phase.peak), "horizontal")} />
              </div>
            </div>
            <div className="progress">
              <b style={{ width: `${Math.min(1, phase.elapsed / seconds) * 100}%` }} />
            </div>
            <p className="hint">{t("像平常直播一樣說話，有自然的停頓沒關係。")}</p>
            <button type="button" className="btn" onClick={() => (stopRef.current = true)}>
              <Icon name="square" size={15} />
              {t("提前停止")}
            </button>
          </div>
        )}

        {phase.kind === "analyzing" && (
          <div className="dialog-body">
            <p className="hint">{t("分析中…")}</p>
          </div>
        )}

        {result && (
          <div className="dialog-body">
            {blocking.length > 0 ? (
              <>
                {blocking.map((i) => (
                  <div key={i.kind} className="verdict verdict-bad">
                    {issueText(i.kind)}
                  </div>
                ))}
                <p className="hint">{t("這樣的錄音沒辦法準確分析，所以先不調整濾鏡。")}</p>
              </>
            ) : (
              result.analysis.plan && (
                <>
                  <div className="verdict verdict-ok">
                    {result.analysis.pitchHz
                      ? t("分析完成。你說話的音高大約在 {hz} Hz。", { hz: Math.round(result.analysis.pitchHz) })
                      : t("分析完成。")}
                  </div>
                  {notes.map((i) => (
                    <div key={i.kind} className="verdict verdict-warn">
                      {issueText(i.kind)}
                    </div>
                  ))}
                  <ul className="change-list">
                    {describePlan(result.analysis, result.analysis.plan, result.hasNoiseSuppression).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                  {Math.abs(source.volumeDb) >= 0.5 && (
                    <p className="hint">{t("這個來源的音量推桿目前在 {db} dB。上面的音量是以推桿在 0 dB 計算的。", { db: source.volumeDb.toFixed(1) })}</p>
                  )}
                </>
              )
            )}

            {blocking.length === 0 && result.analysis.plan && (
              <>
                <div className="row-label">{t("試聽")}</div>
                <div className="compare-row">
                  <div className="seg seg-inline" role="group" aria-label={t("試聽")}>
                    <button type="button" aria-pressed={!result.tuned} disabled={busy} onClick={() => listenTo(result, false)}>
                      {t("原本")}
                    </button>
                    <button type="button" aria-pressed={result.tuned} disabled={busy} onClick={() => listenTo(result, true)}>
                      {t("調整後")}
                    </button>
                  </div>
                  {onMonitorType && (
                    <button
                      type="button"
                      className="btn"
                      aria-pressed={listening}
                      onClick={() => onMonitorType(listening ? "off" : "monitorAndOutput")}
                    >
                      <Icon name="headphones" size={15} />
                      {listening ? t("停止監聽") : t("用耳機監聽")}
                    </button>
                  )}
                </div>
                <p className="hint">
                  {onMonitorType
                    ? t("切到「調整後」會先暫時加上濾鏡讓你試聽，按「套用」才會保留；關閉視窗或重錄會恢復原本的濾鏡。用耳機監聽就能聽出差別（請戴耳機，用喇叭會有回音），觀眾聽到的聲音不受影響。")
                    : t("切到「調整後」會先暫時加上濾鏡讓你試聽，按「套用」才會保留；關閉視窗或重錄會恢復原本的濾鏡。開啟這個來源的監聽，或用「試音」錄一段，就能聽出差別。")}
                </p>
              </>
            )}
            <div className="row">
              {blocking.length === 0 && result.analysis.plan && (
                <button type="button" className="btn primary" disabled={busy} onClick={() => apply(result)}>
                  <Icon name="check" size={15} />
                  {t("套用")}
                </button>
              )}
              <button type="button" className="btn" disabled={busy} onClick={record}>
                <Icon name="rotate-ccw" size={15} />
                {t("重錄")}
              </button>
            </div>
            {blocking.length === 0 && result.analysis.plan && <SpectrumChart bands={result.analysis.bands} />}
          </div>
        )}

        {phase.kind === "done" && (
          <div className="dialog-body">
            <div className="verdict verdict-ok">
              {t("已經套用新的設定。原本的濾鏡有備份在「設定檔」裡。")}
            </div>
            <button type="button" className="btn" onClick={onClose}>
              {t("關閉")}
            </button>
          </div>
        )}

        {phase.kind === "error" && (
          <div className="dialog-body">
            <div className="verdict verdict-bad">{phase.message}</div>
            <button type="button" className="btn" onClick={() => setPhase({ kind: "intro" })}>
              <Icon name="rotate-ccw" size={15} />
              {t("重新開始")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
