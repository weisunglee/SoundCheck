import { useState } from "react";
import type { AudioSource, ChannelLevels, MonitorType, SourceStatus } from "../types";
import { LevelMeter } from "./LevelMeter";
import { StatusBadge } from "./StatusBadge";

const MONITOR_OPTIONS: { value: MonitorType; label: string; explain: string }[] = [
  { value: "OBS_MONITORING_TYPE_NONE", label: "關閉", explain: "你的耳機聽不到這個聲音；有送到直播音軌的話，觀眾聽得到。" },
  { value: "OBS_MONITORING_TYPE_MONITOR_ONLY", label: "僅監聽", explain: "只有你的耳機聽得到，觀眾聽不到。" },
  { value: "OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT", label: "監聽輸出", explain: "你的耳機和觀眾都聽得到。" },
];

const SCALE_DB = [0, -10, -20, -30, -40, -50, -60];
const FADER_MIN_DB = -60;
/** Where peaks should sit, following OBS's own meter colours (yellow zone). */
const RECOMMENDED_DB: [number, number] = [-20, -9];
const SYNC_STEP_MS = 10;

interface Props {
  /** DOM id, so the summary can scroll to this card. */
  id: string;
  /** Briefly highlighted after the user jumped to it. */
  flash: boolean;
  source: AudioSource;
  status: SourceStatus;
  sounding: boolean;
  levels: ChannelLevels;
  streamTracks: number[];
  onVolume: (db: number) => void;
  onMuted: (muted: boolean) => void;
  onMonitorType: (type: MonitorType) => void;
  onBalance: (balance: number) => void;
  onSyncOffset: (ms: number) => void;
  onFilterEnabled: (filter: string, enabled: boolean) => void;
  onOpenFilters: () => void;
  onAddStreamTracks: () => void;
  /** Un-hide the source in the current scene. */
  onShow: () => void;
}

export function ChannelStrip(props: Props) {
  const { source, status, sounding, levels, streamTracks } = props;
  const [moreOpen, setMoreOpen] = useState(false);
  const heard = status === "live";
  const shownLevels: ChannelLevels = status === "hidden" ? [0, 0] : levels;
  // OBS goes down to -100 dB (silent); the fader stops at -60.
  const faderDb = Math.max(FADER_MIN_DB, Math.min(0, source.volumeDb));

  return (
    <div id={props.id} className={`strip${heard ? "" : " dimmed"}${props.flash ? " flash" : ""}`}>
      <div className="strip-head">
        <div>
          <h3>{source.name}</h3>
          <div className="dev">{source.device}</div>
        </div>
        {source.global && <span className="tag">全域</span>}
      </div>
      <StatusBadge kind={heard && !sounding ? "silent" : status} />

      {status === "hidden" && (
        <div className="hint">
          在這個場景裡被隱藏了，觀眾聽不到。
          <button type="button" className="link" onClick={props.onShow}>
            顯示它
          </button>
        </div>
      )}
      {status === "offStream" && (
        <div className="hint">
          {source.tracks.length > 0 ? `只送到音軌 ${source.tracks.join("、")}` : "沒有送到任何音軌"}，直播用的是音軌 {streamTracks.join("、")}。
          <button type="button" className="link" onClick={props.onAddStreamTracks}>
            加到直播音軌
          </button>
        </div>
      )}
      {status === "monitorOnly" && (
        <div className="hint">
          監聽模式是「僅監聽」：OBS 只把這個聲音送到你的耳機，直播裡聽不到。
          <button type="button" className="link" onClick={() => props.onMonitorType("OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT")}>
            改成監聽並輸出
          </button>
        </div>
      )}
      {heard && !sounding && <div className="hint">觀眾聽得到，但現在沒有聲音進來。</div>}

      <div className="fader">
        <div className="scale">
          {SCALE_DB.map((db) => (
            <span key={db}>{db}</span>
          ))}
        </div>
        <div className="meters">
          <span
            className="range-band"
            title={`建議範圍：峰值落在 ${RECOMMENDED_DB[0]} 到 ${RECOMMENDED_DB[1]} dB 之間`}
            style={{
              top: `${(-RECOMMENDED_DB[1] / -FADER_MIN_DB) * 100}%`,
              height: `${((RECOMMENDED_DB[1] - RECOMMENDED_DB[0]) / -FADER_MIN_DB) * 100}%`,
            }}
          />
          <LevelMeter level={shownLevels[0]} />
          <LevelMeter level={shownLevels[1]} />
        </div>
        <div className="vol">
          <input
            type="range"
            min={FADER_MIN_DB}
            max={0}
            step={0.5}
            value={faderDb}
            aria-label={`${source.name} 音量`}
            onChange={(e) => props.onVolume(Number(e.target.value))}
          />
          <span className="db">{source.volumeDb <= -100 ? "-∞ dB" : `${source.volumeDb.toFixed(1)} dB`}</span>
        </div>
      </div>

      <button className="mute" type="button" aria-pressed={source.muted} onClick={() => props.onMuted(!source.muted)}>
        {source.muted ? "已靜音（按一下取消）" : "靜音"}
      </button>

      <div className="seg" role="group" aria-label="監聽模式">
        {MONITOR_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            aria-pressed={source.monitorType === opt.value}
            onClick={() => props.onMonitorType(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div className="hint">{MONITOR_OPTIONS.find((o) => o.value === source.monitorType)?.explain}</div>

      <button type="button" className="link more-toggle" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
        {moreOpen ? "收起更多設定" : "更多設定"}
      </button>
      {moreOpen && (
        <div className="more">
          <label className="field">
            <span className="field-label">
              左右平衡 <span className="field-value">{balanceLabel(source.balance)}</span>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={source.balance}
              aria-label={`${source.name} 左右平衡`}
              onChange={(e) => props.onBalance(snapCentre(Number(e.target.value)))}
            />
          </label>
          <label className="field">
            <span className="field-label">
              聲音提早或延後 <span className="field-value">{source.syncOffsetMs} ms</span>
            </span>
            <span className="row">
              <button type="button" className="btn small" onClick={() => props.onSyncOffset(source.syncOffsetMs - SYNC_STEP_MS)}>
                提早 {SYNC_STEP_MS} ms
              </button>
              <button type="button" className="btn small" onClick={() => props.onSyncOffset(source.syncOffsetMs + SYNC_STEP_MS)}>
                延後 {SYNC_STEP_MS} ms
              </button>
            </span>
            <span className="hint">嘴型和聲音對不上時用：聲音比畫面早就按「延後」。</span>
          </label>
        </div>
      )}

      <div className="cap">濾鏡鏈</div>
      <div className="chain">
        {source.filters.map((f) => (
          <button
            key={f.name}
            className="chip"
            type="button"
            aria-pressed={f.enabled}
            title={f.enabled ? "按一下停用" : "按一下啟用"}
            onClick={() => props.onFilterEnabled(f.name, !f.enabled)}
          >
            {f.name}
          </button>
        ))}
        <button type="button" className="chip add" onClick={props.onOpenFilters}>
          {source.filters.length === 0 ? "＋ 加濾鏡" : "調整濾鏡"}
        </button>
      </div>
    </div>
  );
}

/** Snaps near-centre values to exactly centre, which is hard to hit with a slider. */
function snapCentre(balance: number): number {
  return Math.abs(balance - 0.5) < 0.03 ? 0.5 : balance;
}

function balanceLabel(balance: number): string {
  if (balance === 0.5) return "置中";
  const pct = Math.round(Math.abs(balance - 0.5) * 200);
  return balance < 0.5 ? `偏左 ${pct}%` : `偏右 ${pct}%`;
}
