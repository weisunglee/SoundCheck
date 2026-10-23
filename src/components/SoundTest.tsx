import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { meterPosition } from "../levels";
import { loudnessVerdict } from "../loudnessVerdict";
import { meterFill } from "./LevelMeter";
import type { Plugin } from "../plugin";
import { t } from "../i18n";
import { Icon, IconButton } from "./Icon";

interface Summary {
  durationSec: number;
  peakDbfs: number | null;
  rmsDbfs: number | null;
  loudnessLufs: number | null;
  clippedSamples: number;
}

type Phase =
  | { kind: "idle" }
  | { kind: "recording"; elapsed: number; peaks: [number, number] }
  | { kind: "recorded"; summary: Summary }
  | { kind: "playing"; summary: Summary; position: number }
  | { kind: "error"; message: string; summary?: Summary };

const DURATIONS = [5, 10, 15];
/** The plugin restores the stream by itself if it hears nothing for this long. */
const PAUSE_TIMEOUT_MS = 3000;
const HEARTBEAT_MS = 1000;

const fmtDb = (v: number | null, unit: string) => (v === null ? t("無聲") : `${v.toFixed(1)} ${unit}`);

const verdict = (s: Summary) => loudnessVerdict(s.loudnessLufs, s.peakDbfs, s.clippedSamples > 0);

interface Props {
  plugin: Plugin;
  /** Tells the app while playback has the stream silenced. */
  onPlayingChange: (playing: boolean) => void;
  onClose: () => void;
}

export function SoundTest({ plugin, onPlayingChange, onClose }: Props) {
  const [seconds, setSeconds] = useState(10);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const playingRef = useRef(false);

  useEffect(() => {
    const offLevel = listen<{ elapsedSec: number; peaks: [number, number] }>("sound-test-level", (e) =>
      setPhase((p) => (p.kind === "recording" ? { ...p, elapsed: e.payload.elapsedSec, peaks: e.payload.peaks } : p)),
    );
    const offPlay = listen<{ positionSec: number }>("sound-test-playback", (e) =>
      setPhase((p) => (p.kind === "playing" ? { ...p, position: e.payload.positionSec } : p)),
    );
    return () => {
      offLevel.then((f) => f());
      offPlay.then((f) => f());
    };
  }, []);

  const record = async () => {
    setPhase({ kind: "recording", elapsed: 0, peaks: [0, 0] });
    try {
      // The app keeps the stream tap running; recording takes the next `seconds` of it.
      const summary = await invoke<Summary>("sound_test_record", { seconds });
      setPhase({ kind: "recorded", summary });
    } catch (e) {
      setPhase({ kind: "error", message: String((e as Error).message ?? e) });
    }
  };

  const play = async (summary: Summary) => {
    setPhase({ kind: "playing", summary, position: 0 });
    playingRef.current = true;
    onPlayingChange(true);
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      await plugin.pauseStreamAudio(PAUSE_TIMEOUT_MS);
      heartbeat = setInterval(() => plugin.heartbeat().catch(() => {}), HEARTBEAT_MS);
      await invoke("sound_test_play");
      setPhase({ kind: "recorded", summary });
    } catch (e) {
      setPhase({ kind: "error", message: String((e as Error).message ?? e), summary });
    } finally {
      clearInterval(heartbeat);
      playingRef.current = false;
      onPlayingChange(false);
      await plugin.resumeStreamAudio().catch(() => {});
    }
  };

  // Closing mid-playback must still bring the stream audio back.
  const close = () => {
    if (playingRef.current) invoke("sound_test_stop_playback");
    if (phase.kind === "recording") invoke("sound_test_stop_recording");
    onClose();
  };

  const summary = phase.kind === "recorded" || phase.kind === "playing" ? phase.summary : phase.kind === "error" ? phase.summary : undefined;
  const v = summary && verdict(summary);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="sound-test-title">
      <div className="dialog">
        <div className="dialog-head">
          <h2 id="sound-test-title">{t("試音")}</h2>
          <IconButton icon="x" label={t("關閉")} className="close" onClick={close} />
        </div>
        <p className="dialog-lead">
          {t("錄一段直播軟體真正送出去的聲音，再播放給你聽。播放的時候，觀眾會暫時聽不到聲音，播完自動恢復。")}
        </p>

        {phase.kind === "idle" && (
          <div className="dialog-body">
            <div className="row-label">{t("錄音長度")}</div>
            <div className="seg seg-inline" role="group" aria-label={t("錄音長度")}>
              {DURATIONS.map((d) => (
                <button key={d} type="button" aria-pressed={seconds === d} onClick={() => setSeconds(d)}>
                  {t("{n} 秒", { n: d })}
                </button>
              ))}
            </div>
            <p className="hint">{t("開始後請照平常直播的方式說話、玩遊戲或放音樂。")}</p>
            <button type="button" className="btn primary" onClick={record}>
              <Icon name="circle" size={15} />
              {t("開始錄音")}
            </button>
          </div>
        )}

        {phase.kind === "recording" && (
          <div className="dialog-body">
            <div className="rec-status">
              <span className="rec-dot" />
              {t("錄音中 {elapsed} / {total} 秒", { elapsed: phase.elapsed.toFixed(1), total: seconds })}
            </div>
            <div className="hmeters">
              {phase.peaks.map((p, i) => (
                <div key={i} className="hmeter">
                  <b style={meterFill(meterPosition(p), "horizontal")} />
                </div>
              ))}
            </div>
            <div className="progress">
              <b style={{ width: `${(phase.elapsed / seconds) * 100}%` }} />
            </div>
            <button type="button" className="btn" onClick={() => invoke("sound_test_stop_recording")}>
              <Icon name="square" size={15} />
              {t("提前停止")}
            </button>
          </div>
        )}

        {summary && v && (
          <div className="dialog-body">
            <div className={`verdict verdict-${v.tone}`}>{v.text}</div>
            <dl className="stats">
              <div>
                <dt>{t("長度")}</dt>
                <dd>{t("{n} 秒", { n: summary.durationSec.toFixed(1) })}</dd>
              </div>
              <div>
                <dt>{t("最大聲")}</dt>
                <dd>{fmtDb(summary.peakDbfs, "dBFS")}</dd>
              </div>
              <div>
                <dt>{t("整體響度")}</dt>
                <dd>{fmtDb(summary.loudnessLufs, "LUFS")}</dd>
              </div>
            </dl>

            {phase.kind === "playing" ? (
              <>
                <div className="paused-banner">{t("直播聲音暫停中，播完自動恢復")}</div>
                <div className="progress">
                  <b style={{ width: `${(phase.position / summary.durationSec) * 100}%` }} />
                </div>
                <button type="button" className="btn" onClick={() => invoke("sound_test_stop_playback")}>
                  <Icon name="square" size={15} />
                  {t("停止播放")}
                </button>
              </>
            ) : (
              <div className="row">
                <button type="button" className="btn primary" onClick={() => play(summary)}>
                  <Icon name="play" size={15} />
                  {t("播放給我聽")}
                </button>
                <button type="button" className="btn" onClick={record}>
                  <Icon name="rotate-ccw" size={15} />
                  {t("重錄")}
                </button>
              </div>
            )}
          </div>
        )}

        {phase.kind === "error" && (
          <div className="dialog-body">
            <div className="verdict verdict-bad">{phase.message}</div>
            <button type="button" className="btn" onClick={() => setPhase({ kind: "idle" })}>
              <Icon name="rotate-ccw" size={15} />
              {t("重新開始")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
