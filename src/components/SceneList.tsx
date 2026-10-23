import { t } from "../i18n";

interface Props {
  scenes: string[];
  programScene: string;
  /** How many sources the audience can hear in each scene. */
  heardCount: Record<string, number>;
  onSwitch: (scene: string) => void;
}

export function SceneList({ scenes, programScene, heardCount, onSwitch }: Props) {
  return (
    <nav className="scenes" aria-label={t("場景")}>
      <div className="cap">{t("場景")}</div>
      {scenes.map((name) => {
        const current = name === programScene;
        return (
          <button
            key={name}
            type="button"
            className={current ? "scene current" : "scene"}
            aria-current={current}
            onClick={() => onSwitch(name)}
          >
            <span className="scene-name">{name}</span>
            <span className="scene-meta">
              {current ? <span className="onair">{t("直播中")}</span> : t("{n} 個聲音", { n: heardCount[name] ?? 0 })}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
