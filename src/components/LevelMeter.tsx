import { useRef } from "react";

const PEAK_DECAY_PER_UPDATE = 0.012;

/** One vertical meter bar with a slowly falling peak marker. */
export function LevelMeter({ level }: { level: number }) {
  const peak = useRef(0);
  peak.current = Math.max(level, peak.current - PEAK_DECAY_PER_UPDATE);

  return (
    <div className="meter">
      <b style={{ height: `${level * 100}%` }} />
      {peak.current > 0.01 && <s style={{ bottom: `calc(${peak.current * 100}% - 2px)` }} />}
    </div>
  );
}
