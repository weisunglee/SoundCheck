// The voice's long-term spectrum against average speech (0 dB), as measured and as the planned
// voice EQ would make it: one line each, on a log frequency axis.
import { useState } from "react";
import { t } from "../i18n";
import type { VoiceAnalysis } from "../voiceTuning";

const W = 420;
const H = 180;
const PAD = { left: 30, right: 44, top: 10, bottom: 22 };
const F_MIN = 100;
const F_MAX = 10000;
const X_TICKS = [100, 200, 500, 1000, 2000, 5000, 10000];

const x = (f: number) => PAD.left + ((Math.log10(f) - Math.log10(F_MIN)) / (Math.log10(F_MAX) - Math.log10(F_MIN))) * (W - PAD.left - PAD.right);
const hz = (f: number) => (f >= 1000 ? `${f / 1000}k` : `${f}`);
const db = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;

interface Series {
  key: string;
  label: string;
  className: string;
  values: number[];
}

export function SpectrumChart({ bands }: { bands: VoiceAnalysis["bands"] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (bands.length < 2) return null;

  const tuned = bands.every((b) => b.tunedDb !== null) ? bands.map((b) => b.tunedDb as number) : null;
  // The plan may change only the dynamics (compressor, de-esser) and leave the shape as it is.
  const same = tuned !== null && tuned.every((v, i) => Math.abs(v - bands[i].deviationDb) < 0.3);
  const series: Series[] = [
    { key: "before", label: t("原本"), className: "spectrum-before", values: bands.map((b) => b.deviationDb) },
    ...(tuned ? [{ key: "after", label: t("調整後（預估）"), className: "spectrum-after", values: tuned }] : []),
  ];

  // Symmetric around average speech, in 6 dB steps, at least ±12 dB.
  const extent = Math.max(12, Math.ceil(Math.max(...series.flatMap((s) => s.values.map(Math.abs))) / 6) * 6);
  const y = (v: number) => PAD.top + ((extent - v) / (2 * extent)) * (H - PAD.top - PAD.bottom);
  const yTicks: number[] = [];
  for (let v = -extent; v <= extent; v += 6) yTicks.push(v);

  const path = (values: number[]) => values.map((v, i) => `${i ? "L" : "M"}${x(bands[i].freq).toFixed(1)},${y(v).toFixed(1)}`).join("");

  // Direct labels at the right end, pushed apart when the lines end close together.
  const ends = series.map((s) => ({ s, at: y(s.values[s.values.length - 1]) }));
  if (ends.length === 2 && Math.abs(ends[0].at - ends[1].at) < 12) {
    const mid = (ends[0].at + ends[1].at) / 2;
    const up = ends[0].at <= ends[1].at ? 0 : 1;
    ends[up].at = mid - 6;
    ends[1 - up].at = mid + 6;
  }

  // Each band's hover target spans halfway to its neighbours.
  const edges = bands.map((b, i) => {
    const left = i === 0 ? x(b.freq) - 8 : (x(bands[i - 1].freq) + x(b.freq)) / 2;
    const right = i === bands.length - 1 ? x(b.freq) + 8 : (x(b.freq) + x(bands[i + 1].freq)) / 2;
    return [left, right];
  });
  const shown = hover === null ? null : bands[hover];

  return (
    <figure className="spectrum">
      <figcaption className="spectrum-head">
        <span className="row-label">{t("頻譜")}</span>
        <span className="spectrum-legend">
          {series.map((s) => (
            <span key={s.key} className="spectrum-key">
              <span className={`spectrum-swatch ${s.className}`} />
              {s.label}
            </span>
          ))}
        </span>
      </figcaption>
      <div className="spectrum-plot">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={t("你的聲音和一般人說話的平均頻譜相比，0 dB 是平均。")}
          onMouseLeave={() => setHover(null)}
        >
          {yTicks.map((v) => (
            <g key={v}>
              <line className={v === 0 ? "spectrum-zero" : "spectrum-grid"} x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />
              <text className="spectrum-axis" x={PAD.left - 4} y={y(v) + 3} textAnchor="end">
                {v > 0 ? `+${v}` : v}
              </text>
            </g>
          ))}
          {X_TICKS.map((f) => (
            <text key={f} className="spectrum-axis" x={x(f)} y={H - 6} textAnchor="middle">
              {hz(f)}
            </text>
          ))}
          {shown && <line className="spectrum-cross" x1={x(shown.freq)} x2={x(shown.freq)} y1={PAD.top} y2={H - PAD.bottom} />}
          {series.map((s) => (
            <path key={s.key} className={`spectrum-line ${s.className}`} d={path(s.values)} />
          ))}
          {hover !== null &&
            series.map((s) => <circle key={s.key} className={`spectrum-dot ${s.className}`} cx={x(bands[hover].freq)} cy={y(s.values[hover])} r={4} />)}
          {ends.map(({ s, at }) => (
            <text key={s.key} className="spectrum-label" x={W - PAD.right + 6} y={at + 3}>
              {s.key === "before" ? t("原本") : t("調整後")}
            </text>
          ))}
          {edges.map(([left, right], i) => (
            <rect
              key={bands[i].freq}
              className="spectrum-hit"
              x={left}
              y={PAD.top}
              width={right - left}
              height={H - PAD.top - PAD.bottom}
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </svg>
        {shown && hover !== null && (
          <div
            className="spectrum-tip"
            style={{ left: `${(x(shown.freq) / W) * 100}%`, transform: `translateX(${x(shown.freq) > W / 2 ? "-100%" : "0"})` }}
          >
            <b>{shown.freq >= 1000 ? `${shown.freq / 1000} kHz` : `${shown.freq} Hz`}</b>
            {series.map((s) => (
              <span key={s.key}>
                <span className={`spectrum-swatch ${s.className}`} />
                {s.label} {db(s.values[hover])}
              </span>
            ))}
          </div>
        )}
      </div>
      {same && <p className="hint">{t("這次的調整主要是音量和動態（壓縮、去齒音），不太改變頻譜的形狀，所以兩條線幾乎重疊。")}</p>}
      <p className="hint">
        {tuned
          ? t("和一般人說話的平均頻譜相比：高於 0 是比較多，低於 0 是比較少。調整後的線是依濾鏡設定算出來的，去齒音只在齒音太重時才作用，沒有畫在圖上。")
          : t("和一般人說話的平均頻譜相比：高於 0 是比較多，低於 0 是比較少。")}
      </p>
      <details className="spectrum-table">
        <summary>{t("顯示數值")}</summary>
        <table>
          <thead>
            <tr>
              <th>{t("頻率")}</th>
              {series.map((s) => (
                <th key={s.key}>{s.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bands.map((b, i) => (
              <tr key={b.freq}>
                <td>{hz(b.freq)}</td>
                {series.map((s) => (
                  <td key={s.key}>{db(s.values[i])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
