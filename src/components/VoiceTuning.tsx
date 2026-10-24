import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { FilterOps, SoftwareAdapter } from "../adapter";
import { t } from "../i18n";
import { meterPosition } from "../levels";
import { type Plugin, VOICE_PLUGIN_VERSION, compareVersions } from "../plugin";
import { saveBackup } from "../profiles";
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
  | { kind: "result"; analysis: VoiceAnalysis; hasNoiseSuppression: boolean }
  | { kind: "applying"; analysis: VoiceAnalysis; hasNoiseSuppression: boolean }
  | { kind: "applied"; analysis: VoiceAnalysis; hasNoiseSuppression: boolean; applied: Applied; tuned: boolean }
  | { kind: "done"; kept: boolean }
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

  // Closing mid-recording still takes the analyzer off the source.
  useEffect(
    () => () => {
      stopRef.current = true;
      if (recordingRef.current) {
        plugin?.stopVoiceCapture(name).catch(() => {});
        removeAnalyzers(ops, name).catch(() => {});
      }
    },
    [ops, plugin, name],
  );

  const ready = plugin && pluginVersion && compareVersions(pluginVersion, VOICE_PLUGIN_VERSION) >= 0;

  const record = async () => {
    if (!plugin) return;
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
      setPhase({ kind: "result", analysis, hasNoiseSuppression });
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

  const apply = (analysis: VoiceAnalysis, hasNoiseSuppression: boolean) =>
    run(async () => {
      if (!analysis.plan) return;
      setPhase({ kind: "applying", analysis, hasNoiseSuppression });
      // A backup the user can still apply from Profiles after closing this.
      await saveBackup(adapter, [source]);
      const applied = await applyPlan(ops, name, analysis.plan);
      setPhase({ kind: "applied", analysis, hasNoiseSuppression, applied, tuned: true });
      // applyPlan puts things back itself when a step fails.
    }, () => setPhase({ kind: "result", analysis, hasNoiseSuppression }));

  const switchTo = (p: Extract<Phase, { kind: "applied" }>, tuned: boolean) =>
    run(async () => {
      await compare(ops, name, p.applied, tuned);
      setPhase({ ...p, tuned });
    });

  // Closing after applying keeps the tuned chain, as "Keep" does.
  const close = () => {
    if (phase.kind === "applied") finish(ops, name, phase.applied).catch(() => {});
    if (phase.kind === "recording") stopRef.current = true;
    onClose();
  };

  const result = phase.kind === "result" || phase.kind === "applying" || phase.kind === "applied" ? phase : null;
  const blocking = result?.analysis.issues.filter((i) => i.blocking) ?? [];
  const notes = result?.analysis.issues.filter((i) => !i.blocking && i.kind !== "someNoise") ?? [];

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="voice-title">
      <div className="dialog">
        <div className="dialog-head">
          <h2 id="voice-title">{t("自動調整人聲：{source}", { source: name })}</h2>
          <IconButton icon="x" label={t("關閉")} className="close" onClick={close} />
        </div>

        {error && <div className="verdict verdict-bad">{error}</div>}

        {phase.kind === "intro" && (
          <div className="dialog-body">
            <p className="dialog-lead">
              {t("錄一段你說話的聲音，分析你的聲線，再自動設定濾鏡：切掉低頻雜音、讓聲音不悶、字更清楚，音量也調到剛好。套用前會先備份目前的濾鏡，不喜歡可以一鍵復原。")}
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
                  <SpectrumChart bands={result.analysis.bands} />
                  {Math.abs(source.volumeDb) >= 0.5 && (
                    <p className="hint">{t("這個來源的音量推桿目前在 {db} dB。上面的音量是以推桿在 0 dB 計算的。", { db: source.volumeDb.toFixed(1) })}</p>
                  )}
                </>
              )
            )}

            {phase.kind === "applied" ? (
              <>
                <div className="row-label">{t("比較")}</div>
                <div className="compare-row">
                  <div className="seg seg-inline" role="group" aria-label={t("比較")}>
                    <button type="button" aria-pressed={phase.tuned} disabled={busy} onClick={() => switchTo(phase, true)}>
                      {t("調整後")}
                    </button>
                    <button type="button" aria-pressed={!phase.tuned} disabled={busy} onClick={() => switchTo(phase, false)}>
                      {t("原本")}
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
                    ? t("切換會馬上生效。用耳機監聽就能聽出差別（請戴耳機，用喇叭會有回音），觀眾聽到的聲音不受影響。關閉這個視窗後，監聽會恢復成原本的設定。")
                    : t("切換會馬上生效。開啟這個來源的監聽，或用「試音」錄一段，就能聽出差別。")}
                </p>
                <div className="row">
                  <button
                    type="button"
                    className="btn primary"
                    disabled={busy}
                    onClick={() => run(async () => (await finish(ops, name, phase.applied), setPhase({ kind: "done", kept: true })))}
                  >
                    <Icon name="check" size={15} />
                    {t("保留調整")}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => run(async () => (await undo(ops, name, phase.applied), setPhase({ kind: "done", kept: false })))}
                  >
                    <Icon name="undo-2" size={15} />
                    {t("復原")}
                  </button>
                </div>
              </>
            ) : (
              <div className="row">
                {blocking.length === 0 && result.analysis.plan && (
                  <button
                    type="button"
                    className="btn primary"
                    disabled={busy || phase.kind === "applying"}
                    onClick={() => apply(result.analysis, result.hasNoiseSuppression)}
                  >
                    <Icon name="wand-sparkles" size={15} />
                    {phase.kind === "applying" ? t("套用中…") : t("套用")}
                  </button>
                )}
                <button type="button" className="btn" disabled={busy || phase.kind === "applying"} onClick={record}>
                  <Icon name="rotate-ccw" size={15} />
                  {t("重錄")}
                </button>
              </div>
            )}
          </div>
        )}

        {phase.kind === "done" && (
          <div className="dialog-body">
            <div className="verdict verdict-ok">
              {phase.kept
                ? t("已經保留新的設定。原本的濾鏡有備份在「設定檔」裡。")
                : t("已經復原成原本的濾鏡。")}
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
