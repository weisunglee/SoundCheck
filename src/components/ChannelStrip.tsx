import type { AudioSource, ChannelLevels, MonitorType, SourceStatus } from "../types";
import { LevelMeter } from "./LevelMeter";
import { StatusBadge } from "./StatusBadge";

const MONITOR_OPTIONS: { value: MonitorType; label: string }[] = [
  { value: "OBS_MONITORING_TYPE_NONE", label: "關閉" },
  { value: "OBS_MONITORING_TYPE_MONITOR_ONLY", label: "僅監聽" },
  { value: "OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT", label: "監聽輸出" },
];

const SCALE_DB = [0, -10, -20, -30, -40, -50, -60];
const FADER_MIN_DB = -60;

interface Props {
  source: AudioSource;
  status: SourceStatus;
  sounding: boolean;
  levels: ChannelLevels;
  streamTracks: number[];
  onVolume: (db: number) => void;
  onMuted: (muted: boolean) => void;
  onMonitorType: (type: MonitorType) => void;
  onFilterEnabled: (filter: string, enabled: boolean) => void;
  onAddStreamTracks: () => void;
  /** Un-hide the source in the current scene. */
  onShow: () => void;
}

export function ChannelStrip(props: Props) {
  const { source, status, sounding, levels, streamTracks } = props;
  const heard = status === "live";
  const shownLevels: ChannelLevels = status === "hidden" ? [0, 0] : levels;
  // OBS goes down to -100 dB (silent); the fader stops at -60.
  const faderDb = Math.max(FADER_MIN_DB, Math.min(0, source.volumeDb));

  return (
    <div className={heard ? "strip" : "strip dimmed"}>
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
      {heard && !sounding && <div className="hint">觀眾聽得到，但現在沒有聲音進來。</div>}

      <div className="fader">
        <div className="scale">
          {SCALE_DB.map((db) => (
            <span key={db}>{db}</span>
          ))}
        </div>
        <div className="meters">
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

      <div className="cap">濾鏡鏈</div>
      <div className="chain">
        {source.filters.length === 0 && <span className="hint">沒有音訊濾鏡</span>}
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
      </div>
    </div>
  );
}
