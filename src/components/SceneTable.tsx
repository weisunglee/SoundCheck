import type { AudioSource, SourceStatus } from "../types";
import { StatusDot, statusLabel } from "./StatusBadge";
import { t } from "../i18n";

interface Props {
  sources: AudioSource[];
  scenes: string[];
  programScene: string;
  statusIn: (source: AudioSource, scene: string) => SourceStatus;
  onSwitch: (scene: string) => void;
}

const LEGEND: SourceStatus[] = ["live", "hidden", "muted", "monitorOnly", "offStream", "notInScene"];

/** Every audio source against every scene, so the user can see where each sound plays. */
export function SceneTable({ sources, scenes, programScene, statusIn, onSwitch }: Props) {
  return (
    <div className="table-wrap">
      <table className="scene-table">
        <thead>
          <tr>
            <th>{t("聲音來源")}</th>
            {scenes.map((s) => (
              <th key={s} className={s === programScene ? "current" : undefined}>
                <button type="button" className="link" onClick={() => onSwitch(s)}>
                  {s}
                </button>
                {s === programScene && <span className="onair">{t("直播中")}</span>}
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
                  {src.global && <span className="tag">{t("全域")}</span>}
                </div>
                <div className="dev">{t(src.device)}</div>
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
            {k === "live" ? t("觀眾聽得到") : statusLabel(k)}
          </span>
        ))}
      </div>
    </div>
  );
}
