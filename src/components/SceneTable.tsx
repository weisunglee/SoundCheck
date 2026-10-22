import type { AudioSource, SourceStatus } from "../types";
import { StatusDot } from "./StatusBadge";

interface Props {
  sources: AudioSource[];
  scenes: string[];
  programScene: string;
  statusIn: (source: AudioSource, scene: string) => SourceStatus;
  onSwitch: (scene: string) => void;
}

const LEGEND: SourceStatus[] = ["live", "hidden", "muted", "offStream", "notInScene"];

/** Every audio source against every scene, so the user can see where each sound plays. */
export function SceneTable({ sources, scenes, programScene, statusIn, onSwitch }: Props) {
  return (
    <div className="table-wrap">
      <table className="scene-table">
        <thead>
          <tr>
            <th>聲音來源</th>
            {scenes.map((s) => (
              <th key={s} className={s === programScene ? "current" : undefined}>
                <button type="button" className="link" onClick={() => onSwitch(s)}>
                  {s}
                </button>
                {s === programScene && <span className="onair">直播中</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sources.map((src) => (
            <tr key={src.name}>
              <td>
                <div className="src-name">
                  {src.name}
                  {src.global && <span className="tag">全域</span>}
                </div>
                <div className="dev">{src.device}</div>
              </td>
              {scenes.map((s) => (
                <td key={s} className={s === programScene ? "current" : undefined}>
                  <StatusDot kind={statusIn(src, s)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="legend">
        {LEGEND.map((k) => (
          <span key={k}>
            <StatusDot kind={k} />
            {{ live: "觀眾聽得到", hidden: "已隱藏", muted: "已靜音", offStream: "沒送到直播", notInScene: "不在這個場景" }[k]}
          </span>
        ))}
      </div>
    </div>
  );
}
