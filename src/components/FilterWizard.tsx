import { useCallback, useEffect, useRef, useState } from "react";
import type { FilterOps, SourceFilter } from "../adapter";
import { FILTERS, PROBLEMS, addFilter } from "../filters";
import { t } from "../i18n";
import { Icon, IconButton } from "./Icon";

type Settings = Record<string, string | number | boolean>;

interface Props {
  ops: FilterOps;
  sourceName: string;
  /** Live input peak of the source in dBFS, or null when silent or unknown. */
  inputDb: number | null;
  onClose: () => void;
}

const SETTINGS_DEBOUNCE_MS = 150;

export function FilterWizard({ ops, sourceName, inputDb, onClose }: Props) {
  const [filters, setFilters] = useState<SourceFilter[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(
    () =>
      ops
        .list(sourceName)
        .then((f) => (setFilters(f), setError(null)))
        .catch((e: Error) => setError(t("讀取濾鏡失敗：{error}", { error: e.message }))),
    [ops, sourceName],
  );

  useEffect(() => {
    reload();
    return ops.watch(sourceName, reload);
  }, [ops, reload, sourceName]);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run();
      await reload();
    } catch (e) {
      setError(t("直播軟體沒有接受這個變更：{error}", { error: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const audioFilters = (filters ?? []).filter((f) => FILTERS[f.kind]);
  const has = (kind: string) => audioFilters.some((f) => f.kind === kind);

  const solve = (kinds: string[]) =>
    act(async () => {
      let last: string | null = null;
      for (const kind of kinds) if (!has(kind)) last = await addFilter(ops, sourceName, kind);
      if (last) setOpen(last);
    });

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="filter-title">
      <div className="dialog wide">
        <div className="dialog-head">
          <h2 id="filter-title">{t("{source} 的聲音處理", { source: sourceName })}</h2>
          <IconButton icon="x" label={t("關閉")} className="close" onClick={onClose} />
        </div>

        {error && <div className="verdict verdict-bad">{error}</div>}

        <section className="wizard-section">
          <h4 className="section-title">{t("你遇到什麼問題？")}</h4>
          <div className="problems">
            {PROBLEMS.map((p) => {
              const solved = p.kinds.every(has);
              return (
                <button key={p.id} type="button" className="problem" disabled={busy || solved || !filters} onClick={() => solve(p.kinds)}>
                  <span className="problem-title">{t(p.title)}</span>
                  <span className="problem-detail">{solved ? t("已經加上了") : t(p.detail)}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="wizard-section">
          <h4 className="section-title">{t("目前的濾鏡（由上往下依序處理）")}</h4>
          {!filters ? (
            <p className="hint">{t("讀取中…")}</p>
          ) : audioFilters.length === 0 ? (
            <p className="hint">{t("還沒有任何聲音濾鏡。從上面選一個問題開始。")}</p>
          ) : (
            <ul className="filter-list">
              {audioFilters.map((f, i) => (
                <FilterCard
                  key={f.name}
                  ops={ops}
                  sourceName={sourceName}
                  filter={f}
                  inputDb={inputDb}
                  expanded={open === f.name}
                  busy={busy}
                  first={i === 0}
                  last={i === audioFilters.length - 1}
                  onToggleExpanded={() => setOpen(open === f.name ? null : f.name)}
                  onEnabled={(on) => act(() => ops.setEnabled(sourceName, f.name, on))}
                  onMove={(delta) => act(() => ops.move(sourceName, f.name, audioFilters[i + delta].index))}
                  onRemove={() => act(() => ops.remove(sourceName, f.name))}
                  onError={setError}
                />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

interface CardProps {
  ops: FilterOps;
  sourceName: string;
  filter: SourceFilter;
  inputDb: number | null;
  expanded: boolean;
  busy: boolean;
  first: boolean;
  last: boolean;
  onToggleExpanded: () => void;
  onEnabled: (on: boolean) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  onError: (message: string) => void;
}

function FilterCard(props: CardProps) {
  const { sourceName, filter } = props;
  const info = FILTERS[filter.kind];
  const [settings, setSettings] = useState<Settings>(filter.settings);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef<Settings>({});

  // Values reloaded from OBS win, unless the user is in the middle of changing them.
  useEffect(() => {
    if (Object.keys(pending.current).length === 0) setSettings(filter.settings);
  }, [filter.settings]);

  const flush = () => {
    clearTimeout(timer.current);
    const send = pending.current;
    if (Object.keys(send).length === 0) return;
    pending.current = {};
    props.ops.setSettings(sourceName, filter.name, send).catch((e: Error) => props.onError(t("直播軟體沒有接受這個設定：{error}", { error: e.message })));
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  // Each slider change shows immediately; OBS gets the latest values once dragging pauses.
  const change = (patch: Settings) => {
    setSettings((s) => ({ ...s, ...patch }));
    pending.current = { ...pending.current, ...patch };
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, SETTINGS_DEBOUNCE_MS);
  };
  // Closing the dialog right after moving a slider still sends that last value.
  useEffect(() => () => flushRef.current(), []);

  const editor = EDITORS[filter.kind];

  return (
    <li className={filter.enabled ? "filter-card" : "filter-card off"}>
      <div className="filter-head">
        <label className="switch" title={filter.enabled ? t("按一下停用") : t("按一下啟用")}>
          <input type="checkbox" checked={filter.enabled} disabled={props.busy} onChange={(e) => props.onEnabled(e.target.checked)} />
          <span className="filter-name">{filter.name}</span>
        </label>
        {filter.name !== t(info.label) && <span className="tag">{t(info.label)}</span>}
        <span className="spacer" />
        <IconButton icon="arrow-up" label={t("往上移")} disabled={props.busy || props.first} onClick={() => props.onMove(-1)} />
        <IconButton icon="arrow-down" label={t("往下移")} disabled={props.busy || props.last} onClick={() => props.onMove(1)} />
        {confirmRemove ? (
          <>
            <button type="button" className="btn small danger" disabled={props.busy} onClick={props.onRemove}>
              {t("確定移除")}
            </button>
            <button type="button" className="btn small" onClick={() => setConfirmRemove(false)}>
              {t("取消")}
            </button>
          </>
        ) : (
          <IconButton icon="trash-2" label={t("移除")} className="danger" disabled={props.busy} onClick={() => setConfirmRemove(true)} />
        )}
      </div>
      <p className="filter-what">{t(info.what)}</p>
      {editor ? (
        <>
          <button type="button" className="link more-toggle" aria-expanded={props.expanded} onClick={props.onToggleExpanded}>
            <Icon name={props.expanded ? "chevron-up" : "chevron-down"} size={14} />
            {props.expanded ? t("收起設定") : t("調整設定")}
          </button>
          {props.expanded && editor({ settings, change, inputDb: props.inputDb })}
        </>
      ) : (
        <p className="hint">{t("這個濾鏡的設定請到直播軟體的濾鏡視窗調整。")}</p>
      )}
    </li>
  );
}

interface EditorProps {
  settings: Settings;
  change: (patch: Settings) => void;
  inputDb: number | null;
}

const num = (v: unknown, fallback: number) => (typeof v === "number" ? v : fallback);

function Slider(props: { label: string; value: number; min: number; max: number; step?: number; unit: string; hint?: string; onChange: (v: number) => void }) {
  return (
    <label className="field">
      <span className="field-label">
        {props.label}
        <span className="field-value">
          {props.value.toFixed(props.step && props.step < 1 ? 1 : 0)} {props.unit}
        </span>
      </span>
      <input type="range" min={props.min} max={props.max} step={props.step ?? 1} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
      {props.hint && <span className="hint">{props.hint}</span>}
    </label>
  );
}

const BAR_MIN_DB = -60;
const pct = (db: number) => `${Math.max(0, Math.min(1, (db - BAR_MIN_DB) / -BAR_MIN_DB)) * 100}%`;

/** A -60..0 dB bar with the live input level and marker lines. */
function LevelBar({ inputDb, markers }: { inputDb: number | null; markers: { db: number; label: string; tone: string }[] }) {
  return (
    <div className="level-bar" aria-hidden="true">
      <b style={{ width: inputDb === null ? 0 : pct(inputDb) }} />
      {markers.map((m) => (
        <span key={m.label} className={`marker marker-${m.tone}`} style={{ left: pct(m.db) }}>
          <em>{m.label}</em>
        </span>
      ))}
      <div className="level-scale">
        {[-60, -40, -20, 0].map((db) => (
          <span key={db} style={{ left: pct(db) }}>
            {db}
          </span>
        ))}
      </div>
    </div>
  );
}

const EDITORS: Record<string, (p: EditorProps) => React.ReactNode> = {
  noise_suppress_filter_v2: ({ settings, change }) => {
    const method = String(settings.method ?? "rnnoise");
    return (
      <div className="editor">
        <div className="seg seg-inline" role="group" aria-label={t("噪音抑制方式")}>
          <button type="button" aria-pressed={method === "rnnoise"} onClick={() => change({ method: "rnnoise" })}>
            RNNoise
          </button>
          <button type="button" aria-pressed={method === "speex"} onClick={() => change({ method: "speex" })}>
            Speex
          </button>
        </div>
        <p className="hint">
          {method === "speex"
            ? t("Speex 最省電腦資源，效果比較普通，可以調整壓制強度。")
            : method === "rnnoise"
              ? t("RNNoise 效果好、聲音自然，是大多數人的首選。")
              : t("這個濾鏡用的是 NVIDIA 降噪，設定請到直播軟體調整；按上面的按鈕會改成 RNNoise 或 Speex。")}
        </p>
        {method === "speex" && (
          <Slider label={t("壓制強度")} value={num(settings.suppress_level, -30)} min={-60} max={0} unit="dB" hint={t("數字越小壓得越多，太多人聲會變得不自然。")} onChange={(v) => change({ suppress_level: v })} />
        )}
      </div>
    );
  },

  noise_gate_filter: ({ settings, change, inputDb }) => {
    const open = num(settings.open_threshold, -26);
    const close = num(settings.close_threshold, -32);
    return (
      <div className="editor">
        <LevelBar
          inputDb={inputDb}
          markers={[
            { db: close, label: t("關上"), tone: "hot" },
            { db: open, label: t("打開"), tone: "ok" },
          ]}
        />
        <p className="hint">
          {t("說話時音量條要超過「打開」線。音量條量的是經過所有濾鏡之後的聲音，所以噪音閘關上時會掉到最左邊，這代表它正在擋掉聲音。邊講話邊調最準。")}
        </p>
        <Slider label={t("打開的音量")} value={open} min={-60} max={0} unit="dB" onChange={(v) => change({ open_threshold: v, close_threshold: Math.min(close, v) })} />
        <Slider label={t("關上的音量")} value={close} min={-60} max={0} unit="dB" hint={t("要比「打開」低一點，才不會在說話時一直開開關關。")} onChange={(v) => change({ close_threshold: v, open_threshold: Math.max(open, v) })} />
      </div>
    );
  },

  compressor_filter: ({ settings, change, inputDb }) => {
    const threshold = num(settings.threshold, -18);
    const ratio = num(settings.ratio, 4);
    const gain = num(settings.output_gain, 0);
    return (
      <div className="editor">
        <div className="editor-row">
          <div className="editor-col narrow">
            <CompressorCurve threshold={threshold} ratio={ratio} gain={gain} />
            <span className="hint">{t("橫軸是進來的音量，縱軸是出去的音量；黃線以右的聲音會被壓小。")}</span>
            <LevelBar inputDb={inputDb} markers={[{ db: threshold, label: t("開始壓縮"), tone: "hot" }]} />
          </div>
          <div className="editor-col">
            <Slider label={t("開始壓縮的音量")} value={threshold} min={-60} max={0} unit="dB" hint={t("比這個大聲的部分才會被壓小。")} onChange={(v) => change({ threshold: v })} />
            <Slider label={t("壓縮比例")} value={ratio} min={1} max={20} step={0.5} unit=": 1" hint={t("說話用 3～6 比較自然；越大壓得越平。")} onChange={(v) => change({ ratio: v })} />
            <Slider label={t("壓縮後補回的音量")} value={gain} min={0} max={20} step={0.5} unit="dB" hint={t("壓縮會讓整體變小聲，用這個補回來。")} onChange={(v) => change({ output_gain: v })} />
          </div>
        </div>
      </div>
    );
  },

  limiter_filter: ({ settings, change, inputDb }) => {
    const threshold = num(settings.threshold, -6);
    return (
      <div className="editor">
        <LevelBar inputDb={inputDb} markers={[{ db: threshold, label: t("上限"), tone: "hot" }]} />
        <Slider label={t("音量上限")} value={threshold} min={-20} max={0} step={0.5} unit="dB" hint={t("-1 到 -3 dB 最常見。設太低會讓大聲的地方聽起來被悶住。")} onChange={(v) => change({ threshold: v })} />
      </div>
    );
  },

  gain_filter: ({ settings, change }) => (
    <div className="editor">
      <Slider label={t("放大或縮小")} value={num(settings.db, 0)} min={-20} max={20} step={0.5} unit="dB" hint={t("+6 dB 大約是聽起來大一倍。放大太多會連雜音一起變大。")} onChange={(v) => change({ db: v })} />
    </div>
  ),
};

/** Output level against input level, so the user can see what the compressor does. */
function CompressorCurve({ threshold, ratio, gain }: { threshold: number; ratio: number; gain: number }) {
  const size = 140;
  const lo = -60;
  const toX = (db: number) => ((db - lo) / -lo) * size;
  const toY = (db: number) => size - Math.max(0, Math.min(1, (db - lo) / -lo)) * size;
  const out = (db: number) => (db < threshold ? db : threshold + (db - threshold) / ratio) + gain;
  const points = [lo, threshold, 0].map((db) => `${toX(db)},${toY(out(db))}`).join(" ");
  return (
    <svg className="curve" viewBox={`-4 -4 ${size + 8} ${size + 8}`} width={size + 8} height={size + 8} role="img" aria-label={t("壓縮曲線")}>
      <rect x={0} y={0} width={size} height={size} className="curve-bg" />
      <line x1={0} y1={size} x2={size} y2={0} className="curve-ref" />
      <line x1={toX(threshold)} y1={0} x2={toX(threshold)} y2={size} className="curve-threshold" />
      <polyline points={points} className="curve-line" />
    </svg>
  );
}
