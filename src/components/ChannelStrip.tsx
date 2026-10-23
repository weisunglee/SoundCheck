import { useState } from "react";
import type { Capabilities } from "../adapter";
import type { AudioSource, ChannelLevels, MonitorType, SourceStatus } from "../types";
import { Icon, IconButton } from "./Icon";
import { LevelMeter } from "./LevelMeter";
import { StatusBadge } from "./StatusBadge";
import { msg, t } from "../i18n";

const MONITOR_OPTIONS: { value: MonitorType; label: string; explain: string }[] = [
  { value: "off", label: msg("不監聽"), explain: msg("你的耳機聽不到這個聲音；有送到直播音軌的話，觀眾聽得到。") },
  { value: "monitorOnly", label: msg("僅監聽"), explain: msg("只有你的耳機聽得到，觀眾聽不到。") },
  { value: "monitorAndOutput", label: msg("監聽輸出"), explain: msg("你的耳機和觀眾都聽得到。") },
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
  /** What the connected software lets SoundCheck change; unsupported controls are hidden. */
  caps: Capabilities;
  onAddStreamTracks: () => void;
  /** Shows or hides the source in the current scene (the eye toggle). */
  onVisible: (visible: boolean) => void;
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
        <div className="strip-title">
          <h3 title={source.name}>{source.name}</h3>
          <div className="dev">{t(source.device)}</div>
        </div>
        {source.global ? (
          <span className="tag">{t("全域")}</span>
        ) : (
          // Global devices aren't scene items, so only scene sources can be hidden.
          <IconButton
            icon={status === "hidden" ? "eye-off" : "eye"}
            label={status === "hidden" ? t("在這個場景顯示") : t("在這個場景隱藏")}
            className={status === "hidden" ? "off" : undefined}
            onClick={() => props.onVisible(status === "hidden")}
          />
        )}
      </div>
      <div className="strip-status">
      <StatusBadge kind={heard && !sounding ? "silent" : status} />

      {status === "hidden" && (
        <div className="hint">{t("在這個場景裡被隱藏了，觀眾聽不到。")}</div>
      )}
      {status === "offStream" && (
        <div className="hint">
          {source.tracks.length > 0 ? t("只送到音軌 {tracks}", { tracks: source.tracks.join(t("、")) }) : t("沒有送到任何音軌")}
          {t("，直播用的是音軌 {tracks}。", { tracks: streamTracks.join(t("、")) })}
          {props.caps.tracksControl && (
            <button type="button" className="link" onClick={props.onAddStreamTracks}>
              {t("加到直播音軌")}
            </button>
          )}
        </div>
      )}
      {status === "monitorOnly" && (
        <div className="hint">
          {t("監聽模式是「僅監聽」：直播軟體只把這個聲音送到你的耳機，直播裡聽不到。")}
          {props.caps.monitoringControl && (
            <button type="button" className="link" onClick={() => props.onMonitorType("monitorAndOutput")}>
              {t("改成監聽並輸出")}
            </button>
          )}
        </div>
      )}
      {heard && !sounding && <div className="hint">{t("觀眾聽得到，但現在沒有聲音進來。")}</div>}
      </div>

      <div className="fader">
        <div className="scale">
          {SCALE_DB.map((db) => (
            <span key={db}>{db}</span>
          ))}
        </div>
        <div className={props.caps.meters ? "meters" : "meters no-meter"} title={props.caps.meters ? undefined : t("{app} 不提供音量表")}>
          <span
            className="range-band"
            title={t("建議範圍：峰值落在 {low} 到 {high} dB 之間", { low: RECOMMENDED_DB[0], high: RECOMMENDED_DB[1] })}
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
            aria-label={t("{source} 音量", { source: source.name })}
            onChange={(e) => props.onVolume(Number(e.target.value))}
          />
          <span className="db">{source.volumeDb <= -100 ? "-∞ dB" : `${source.volumeDb.toFixed(1)} dB`}</span>
        </div>
      </div>

      <button
        className="mute"
        type="button"
        aria-pressed={source.muted}
        aria-label={source.muted ? t("取消靜音") : t("靜音")}
        title={source.muted ? t("取消靜音") : t("靜音")}
        onClick={() => props.onMuted(!source.muted)}
      >
        <Icon name={source.muted ? "volume-x" : "volume-2"} />
      </button>

      <div className="strip-monitor">
      {props.caps.monitoringControl ? (
        <div className="seg" role="group" aria-label={t("監聽模式")}>
          {MONITOR_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              aria-pressed={source.monitorType === opt.value}
              onClick={() => props.onMonitorType(opt.value)}
            >
              {t(opt.label)}
            </button>
          ))}
        </div>
      ) : (
        <div className="field-label">
          {t("監聽模式")}
          <span className="field-value">{t(MONITOR_OPTIONS.find((o) => o.value === source.monitorType)?.label ?? "")}</span>
        </div>
      )}

      <div className="hint">{t(MONITOR_OPTIONS.find((o) => o.value === source.monitorType)?.explain ?? "")}</div>
      </div>

      <div className="strip-more">
      {(props.caps.balance || props.caps.syncOffset) && (
        <IconButton
          icon="sliders-horizontal"
          label={moreOpen ? t("收起更多設定") : t("更多設定")}
          className="more-toggle"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(!moreOpen)}
        />
      )}
      {moreOpen && (props.caps.balance || props.caps.syncOffset) && (
        <div className="more">
          {props.caps.balance && (
          <label className="field">
            <span className="field-label">
              {t("左右平衡")} <span className="field-value">{balanceLabel(source.balance)}</span>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={source.balance}
              aria-label={t("{source} 左右平衡", { source: source.name })}
              onChange={(e) => props.onBalance(snapCentre(Number(e.target.value)))}
            />
          </label>
          )}
          {props.caps.syncOffset && (
          <label className="field">
            <span className="field-label">
              {t("聲音提早或延後")}
            </span>
            <span className="row stepper">
              <IconButton icon="minus" label={t("提早 {ms} ms", { ms: SYNC_STEP_MS })} onClick={() => props.onSyncOffset(source.syncOffsetMs - SYNC_STEP_MS)} />
              <span className="field-value">{source.syncOffsetMs} ms</span>
              <IconButton icon="plus" label={t("延後 {ms} ms", { ms: SYNC_STEP_MS })} onClick={() => props.onSyncOffset(source.syncOffsetMs + SYNC_STEP_MS)} />
            </span>
            <span className="hint">{t("嘴型和聲音對不上時用：聲音比畫面早就按「延後」。")}</span>
          </label>
          )}
        </div>
      )}

      </div>

      {props.caps.filters && (
      <div className="strip-filters">
      <div className="cap">{t("濾鏡鏈")}</div>
      <div className="chain">
        {source.filters.map((f) => (
          <button
            key={f.name}
            className="chip"
            type="button"
            aria-pressed={f.enabled}
            title={f.enabled ? t("按一下停用") : t("按一下啟用")}
            onClick={() => props.onFilterEnabled(f.name, !f.enabled)}
          >
            {f.name}
          </button>
        ))}
        <button type="button" className="chip add" onClick={props.onOpenFilters}>
          <Icon name={source.filters.length === 0 ? "plus" : "wand-sparkles"} size={13} />
          {source.filters.length === 0 ? t("加濾鏡") : t("調整濾鏡")}
        </button>
      </div>
      </div>
      )}
    </div>
  );
}

/** Snaps near-centre values to exactly centre, which is hard to hit with a slider. */
function snapCentre(balance: number): number {
  return Math.abs(balance - 0.5) < 0.03 ? 0.5 : balance;
}

function balanceLabel(balance: number): string {
  if (balance === 0.5) return t("置中");
  const pct = Math.round(Math.abs(balance - 0.5) * 200);
  return balance < 0.5 ? t("偏左 {pct}%", { pct }) : t("偏右 {pct}%", { pct });
}
