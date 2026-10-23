import type { CSSProperties } from "react";
import { useRef } from "react";

const PEAK_DECAY_PER_UPDATE = 0.012;

/**
 * Shows `fraction` (0..1) of a meter's fill. The fill always spans the whole track, so its
 * green → yellow → red gradient follows the dB scale, and the part above the level is clipped
 * off rather than squeezing or repeating the gradient.
 */
export function meterFill(fraction: number, axis: "horizontal" | "vertical"): CSSProperties {
  const hidden = `${(1 - Math.max(0, Math.min(1, fraction))) * 100}%`;
  return { clipPath: axis === "horizontal" ? `inset(0 ${hidden} 0 0 round 4px)` : `inset(${hidden} 0 0 0 round 4px)` };
}

/** One vertical meter bar with a slowly falling peak marker. */
export function LevelMeter({ level }: { level: number }) {
  const peak = useRef(0);
  peak.current = Math.max(level, peak.current - PEAK_DECAY_PER_UPDATE);

  return (
    <div className="meter">
      <b style={meterFill(level, "vertical")} />
      {peak.current > 0.01 && <s style={{ bottom: `calc(${peak.current * 100}% - 2px)` }} />}
    </div>
  );
}
