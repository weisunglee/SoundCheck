interface Props {
  scenes: string[];
  programScene: string;
  /** How many sources the audience can hear in each scene. */
  heardCount: Record<string, number>;
  onSwitch: (scene: string) => void;
}

export function SceneList({ scenes, programScene, heardCount, onSwitch }: Props) {
  return (
    <nav className="scenes" aria-label="場景">
      <div className="cap">場景</div>
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
              {current ? <span className="onair">直播中</span> : `${heardCount[name] ?? 0} 個聲音`}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
