import { useRef } from "react";
import { loudnessVerdict, toDb } from "../loudnessVerdict";
import type { StreamLevel } from "../streamTap";
import type { AudioSource } from "../types";
import { t } from "../i18n";

interface Props {
  level: StreamLevel | null;
  running: boolean;
  pluginLoaded: boolean;
  /** True while a sound test plays back and the stream is deliberately silent. */
  streamPaused: boolean;
  sources: AudioSource[];
  onInstallPlugin: () => void;
}

const MIN_DB = -60;
const pos = (db: number | null) => (db === null ? 0 : Math.max(0, Math.min(1, (db - MIN_DB) / -MIN_DB)));
/** Hold the peak marker this long so short peaks are readable. */
const PEAK_HOLD_MS = 1500;
/** The verdict looks at the same 3 s window as the short-term loudness, so it doesn't flicker. */
const VERDICT_WINDOW_MS = 3000;

/** What the audience hears, next to what the user's headphones get from OBS monitoring. */
export function StreamMeter({ level, running, pluginLoaded, streamPaused, sources, onInstallPlugin }: Props) {
  const held = useRef<{ db: number; at: number }[]>([
    { db: MIN_DB, at: 0 },
    { db: MIN_DB, at: 0 },
  ]);
  const recentPeaks = useRef<{ db: number; at: number }[]>([]);
  const monitored = sources.filter((s) => s.monitorType !== "OBS_MONITORING_TYPE_NONE").map((s) => s.name);

  const now = performance.now();
  const peaks = (level?.peaks ?? [0, 0]).map(toDb);
  peaks.forEach((db, ch) => {
    const h = held.current[ch];
    if (db !== null && (db >= h.db || now - h.at > PEAK_HOLD_MS)) held.current[ch] = { db, at: now };
    else if (now - h.at > PEAK_HOLD_MS) held.current[ch] = { db: MIN_DB, at: now };
  });
  const stepPeak = Math.max(...peaks.map((p) => p ?? MIN_DB));
  recentPeaks.current = [...recentPeaks.current.filter((p) => now - p.at < VERDICT_WINDOW_MS), { db: stepPeak, at: now }];
  const windowPeak = Math.max(...recentPeaks.current.map((p) => p.db));
  const verdict = level && loudnessVerdict(level.shortTermLufs, windowPeak > MIN_DB ? windowPeak : null);

  return (
    <section className="stream-meter">
      <div className="stream-meter-head">
        <h4 className="section-title">{t("觀眾聽到的（直播送出的聲音）")}</h4>
        {level?.shortTermLufs != null && <span className="lufs">{level.shortTermLufs.toFixed(0)} LUFS</span>}
      </div>

      {!pluginLoaded ? (
        <p className="hint">
          {t("要看到觀眾真正聽到的音量，需要在直播軟體安裝外掛。")}
          <button type="button" className="link" onClick={onInstallPlugin}>
            {t("安裝外掛")}
          </button>
        </p>
      ) : !running ? (
        <p className="hint">{t("正在接上直播的聲音…")}</p>
      ) : (
        <>
          <div className="hmeters">
            {peaks.map((db, ch) => (
              <div key={ch} className="hmeter">
                <b style={{ width: `${pos(db) * 100}%` }} />
                <s style={{ left: `${pos(held.current[ch].db) * 100}%` }} />
              </div>
            ))}
          </div>
          {streamPaused ? (
            <p className="hint">{t("試音播放中，直播聲音暫停。")}</p>
          ) : (
            verdict && <p className={`stream-verdict stream-verdict-${verdict.tone}`}>{verdict.text}</p>
          )}
        </>
      )}

      <p className="hint">
        {monitored.length === 0
          ? t("你的耳機目前不會從直播軟體聽到任何來源。")
          : t("你的耳機會從直播軟體聽到：{list}。這是直播軟體的監聽，不是直播的混音；想聽觀眾聽到的，用「試音」。", { list: monitored.join(t("、")) })}
      </p>
    </section>
  );
}
