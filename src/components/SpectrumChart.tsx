// The voice's long-term spectrum against average speech (0 dB), as measured and as the planned
// voice EQ would make it: the recording as a filled curve, the tuned voice as a line over it.
import { useId, useState } from "react";
import { msg, t } from "../i18n";
import type { VoiceAnalysis } from "../voiceTuning";

const W = 560;
const H = 200;
const PAD = { left: 30, right: 10, top: 22, bottom: 22 };
const F_MIN = 100;
const F_MAX = 10000;
const X_TICKS = [100, 200, 500, 1000, 2000, 5000, 10000];
/** The ranges the tuning looks at, shaded behind the curves. */
const REGIONS = [
  { from: 200, to: 500, label: msg("悶") },
  { from: 2000, to: 5000, label: msg("清晰") },
  { from: 5000, to: 9000, label: msg("齒音") },
];

const x = (f: number) => PAD.left + ((Math.log10(f) - Math.log10(F_MIN)) / (Math.log10(F_MAX) - Math.log10(F_MIN))) * (W - PAD.left - PAD.right);
const hz = (f: number) => (f >= 1000 ? `${f / 1000}k` : `${f}`);
const db = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;

/** A smooth curve through the points (Catmull-Rom as cubic Béziers). */
function smooth(points: [number, number][]): string {
  let d = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const [p0, p1, p2, p3] = [points[i - 1] ?? points[i], points[i], points[i + 1], points[i + 2] ?? points[i + 1]];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

export function SpectrumChart({ bands }: { bands: VoiceAnalysis["bands"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const gradient = useId();
  if (bands.length < 2) return null;

  const before = bands.map((b) => b.deviationDb);
  const tuned = bands.every((b) => b.tunedDb !== null) ? bands.map((b) => b.tunedDb as number) : null;
  // The plan may change only the dynamics (compressor, de-esser) and leave the shape as it is.
  const same = tuned !== null && tuned.every((v, i) => Math.abs(v - before[i]) < 0.3);

  // Symmetric around average speech, in 6 dB steps, at least ±12 dB.
  const extent = Math.max(12, Math.ceil(Math.max(...[...before, ...(tuned ?? [])].map(Math.abs)) / 6) * 6);
  const y = (v: number) => PAD.top + ((extent - v) / (2 * extent)) * (H - PAD.top - PAD.bottom);
  const yTicks: number[] = [];
  for (let v = -extent; v <= extent; v += 6) yTicks.push(v);

  const curve = (values: number[]) => smooth(values.map((v, i) => [x(bands[i].freq), y(v)]));
  const beforeLine = curve(before);
  const first = x(bands[0].freq);
  const last = x(bands[bands.length - 1].freq);
  const beforeArea = `${beforeLine}L${last.toFixed(1)},${y(0).toFixed(1)}L${first.toFixed(1)},${y(0).toFixed(1)}Z`;

  // Each band's hover target spans halfway to its neighbours.
  const edges = bands.map((b, i) => [
    i === 0 ? x(b.freq) - 10 : (x(bands[i - 1].freq) + x(b.freq)) / 2,
    i === bands.length - 1 ? x(b.freq) + 10 : (x(b.freq) + x(bands[i + 1].freq)) / 2,
  ]);
  const shown = hover === null ? null : bands[hover];

  return (
    <figure className="spectrum">
      <figcaption className="spectrum-head">
        <span className="row-label">{t("頻譜")}</span>
        <span className="spectrum-legend">
          <span className="spectrum-key">
            <span className="spectrum-swatch spectrum-before" />
            {t("原本")}
          </span>
          {tuned && (
            <span className="spectrum-key">
              <span className="spectrum-swatch spectrum-after" />
              {t("調整後（預估）")}
            </span>
          )}
        </span>
      </figcaption>
      <div className="spectrum-plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t("你的聲音和一般人說話的平均頻譜相比，0 dB 是平均。")} onMouseLeave={() => setHover(null)}>
          <defs>
            <linearGradient id={gradient} x1="0" x2="0" y1={PAD.top} y2={H - PAD.bottom} gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="var(--series-1)" stopOpacity="0.42" />
              <stop offset="0.5" stopColor="var(--series-1)" stopOpacity="0.06" />
              <stop offset="1" stopColor="var(--series-1)" stopOpacity="0.42" />
            </linearGradient>
          </defs>
          {REGIONS.map((r) => (
            <g key={r.label}>
              <rect className="spectrum-region" x={x(r.from)} width={x(r.to) - x(r.from)} y={PAD.top} height={H - PAD.top - PAD.bottom} />
              <text className="spectrum-region-label" x={(x(r.from) + x(r.to)) / 2} y={PAD.top - 8} textAnchor="middle">
                {t(r.label)}
              </text>
            </g>
          ))}
          {yTicks.map((v) => (
            <g key={v}>
              {v !== 0 && <line className="spectrum-grid" x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />}
              <text className="spectrum-axis" x={PAD.left - 6} y={y(v) + 3} textAnchor="end">
                {v > 0 ? `+${v}` : v}
              </text>
            </g>
          ))}
          {X_TICKS.map((f) => (
            <text key={f} className="spectrum-axis" x={x(f)} y={H - 6} textAnchor="middle">
              {hz(f)}
            </text>
          ))}
          <path d={beforeArea} fill={`url(#${gradient})`} />
          <line className="spectrum-zero" x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} />
          {shown && <line className="spectrum-cross" x1={x(shown.freq)} x2={x(shown.freq)} y1={PAD.top} y2={H - PAD.bottom} />}
          <path className="spectrum-line spectrum-before" d={beforeLine} />
          {tuned && <path className="spectrum-line spectrum-after" d={curve(tuned)} />}
          {hover !== null && (
            <>
              <circle className="spectrum-dot spectrum-before" cx={x(bands[hover].freq)} cy={y(before[hover])} r={4} />
              {tuned && <circle className="spectrum-dot spectrum-after" cx={x(bands[hover].freq)} cy={y(tuned[hover])} r={4} />}
            </>
          )}
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
            style={{ left: `${(x(shown.freq) / W) * 100}%`, transform: `translateX(${x(shown.freq) > W / 2 ? "calc(-100% - 10px)" : "10px"})` }}
          >
            <b>{shown.freq >= 1000 ? `${shown.freq / 1000} kHz` : `${shown.freq} Hz`}</b>
            <span>
              <span className="spectrum-swatch spectrum-before" />
              {t("原本")} {db(before[hover])}
            </span>
            {tuned && (
              <span>
                <span className="spectrum-swatch spectrum-after" />
                {t("調整後")} {db(tuned[hover])}
              </span>
            )}
          </div>
        )}
      </div>
      <p className="hint">
        {same
          ? t("和一般人說話的平均相比，高於 0 是比較多、低於 0 是比較少。這次的調整主要是音量和動態（壓縮、去齒音），頻譜形狀幾乎不變，所以兩條線重疊。")
          : t("和一般人說話的平均相比，高於 0 是比較多、低於 0 是比較少。橘線是依濾鏡設定算出來的；去齒音只在齒音太重時作用，沒有畫進去。")}
      </p>
    </figure>
  );
}
