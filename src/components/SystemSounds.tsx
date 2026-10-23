import { useEffect, useRef, useState } from "react";
import {
  SOUNDING_PEAK,
  appCoverage,
  appLabel,
  deviceCoverage,
  loadCaptureSettings,
  useSystemAudio,
} from "../systemAudio";
import type { AudioSource } from "../types";
import type { AddSourceStart } from "./AddSourceWizard";

interface Props {
  sources: AudioSource[];
  onAdd: (start: AddSourceStart) => void;
}

/** Keep an item listed this long after it goes quiet, so it doesn't flicker between words. */
const HOLD_MS = 4000;

/** Apps and playback devices making sound right now, and whether OBS captures them. */
export function SystemSounds({ sources, onAdd }: Props) {
  const system = useSystemAudio(true, 1000);
  const [captures, setCaptures] = useState<Awaited<ReturnType<typeof loadCaptureSettings>>>(new Map());
  const lastHeard = useRef(new Map<string, number>());

  useEffect(() => {
    loadCaptureSettings(sources).then(setCaptures);
  }, [sources]);

  if (!system?.supported) return null;

  const now = Date.now();
  const recent = (key: string, peak: number) => {
    if (peak > SOUNDING_PEAK) lastHeard.current.set(key, now);
    return now - (lastHeard.current.get(key) ?? -Infinity) < HOLD_MS;
  };

  const apps = system.apps
    .filter((a) => recent(`app:${a.exe}:${a.deviceId}`, a.peak))
    .map((a) => ({ app: a, coverage: appCoverage(a, captures, system.devices) }));
  const devices = system.devices
    .filter((d) => d.flow === "render" && recent(`dev:${d.id}`, d.peak))
    .map((d) => ({ device: d, coverage: deviceCoverage(d, captures, system.devices) }));
  const missing = apps.filter((a) => a.coverage.sources.length === 0).length;
  // Windows only reports a microphone's level while something records it, so inputs that OBS
  // doesn't capture are listed without a level; the add wizard can preview one.
  const missingInputs = system.devices.filter((d) => d.flow === "capture" && deviceCoverage(d, captures, system.devices).sources.length === 0);

  return (
    <section>
      <h4 className="section-title">電腦上正在出聲的聲音{missing > 0 && `（${missing} 個沒有收進 OBS）`}</h4>
      {apps.length === 0 && devices.length === 0 ? (
        <p className="hint">現在電腦上沒有程式在播放聲音。</p>
      ) : (
        <ul className="elsewhere">
          {apps.map(({ app, coverage }) => (
            <li key={`${app.pid}-${app.deviceId}`}>
              <div>
                <div className="src-name">{appLabel(app)}</div>
                <div className="dev">
                  {coverage.sources.length === 0
                    ? "沒有收進 OBS，觀眾聽不到"
                    : coverage.viaDevice
                      ? `透過「${coverage.sources.join("、")}」收進 OBS（和其他電腦聲音一起）`
                      : `已在 OBS：${coverage.sources.join("、")}`}
                </div>
              </div>
              {coverage.sources.length === 0 ? (
                <button type="button" className="btn warn" onClick={() => onAdd({ kind: "app", app })}>
                  加進 OBS
                </button>
              ) : (
                coverage.viaDevice && (
                  <button type="button" className="chip" onClick={() => onAdd({ kind: "app", app })}>
                    單獨收這個程式
                  </button>
                )
              )}
            </li>
          ))}
          {devices
            .filter(({ coverage }) => coverage.sources.length === 0)
            .map(({ device }) => (
              <li key={device.id}>
                <div>
                  <div className="src-name">{device.name}</div>
                  <div className="dev">這個裝置正在播放聲音，但沒有整個收進 OBS</div>
                </div>
                <button type="button" className="chip" onClick={() => onAdd({ kind: "output", deviceId: device.id })}>
                  收進整個裝置的聲音
                </button>
              </li>
            ))}
        </ul>
      )}

      {missingInputs.length > 0 && (
        <details className="inputs-missing">
          <summary>還沒加進 OBS 的輸入裝置（{missingInputs.length} 個）</summary>
          <p className="hint">麥克風、混音器、擷取卡等輸入。沒有程式在錄的裝置無法顯示音量；不確定是哪一個時，按「加進 OBS」後可以試聽。</p>
          <ul className="elsewhere">
            {missingInputs.map((d) => (
              <li key={d.id}>
                <div>
                  <div className="src-name">
                    {d.name}
                    {d.isDefault && <span className="tag">預設</span>}
                  </div>
                </div>
                <button type="button" className="chip" onClick={() => onAdd({ kind: "input", deviceId: d.id })}>
                  加進 OBS
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
