import { useRef, useState } from "react";
import { ChannelStrip } from "./components/ChannelStrip";
import { SceneList } from "./components/SceneList";
import { SceneTable } from "./components/SceneTable";
import { mockScenes, mockSources, mockStreamTracks, mockSwitchableScenes, useMockLevels } from "./mock";
import { scenesContaining, sourceStatus } from "./status";
import type { AudioSource, Scene } from "./types";

/** A level above this counts as "making sound". */
const SOUND_THRESHOLD = 0.05;
/** Keep showing "making sound" this long after the last loud moment, so pauses in speech don't flicker. */
const SOUND_HOLD_MS = 1500;

type View = "scene" | "table";

export default function App() {
  const [sources, setSources] = useState<AudioSource[]>(mockSources);
  const [scenes, setScenes] = useState<Scene[]>(mockScenes);
  const [programScene, setProgramScene] = useState("遊戲");
  const [view, setView] = useState<View>("scene");
  const levels = useMockLevels(sources);
  const streamTracks = mockStreamTracks;

  const lastSound = useRef<Record<string, number>>({});
  const now = performance.now();
  for (const [name, [l, r]] of Object.entries(levels)) {
    if (Math.max(l, r) > SOUND_THRESHOLD) lastSound.current[name] = now;
  }
  const sounding = (name: string) => now - (lastSound.current[name] ?? -Infinity) < SOUND_HOLD_MS;

  const statusIn = (s: AudioSource, scene: string) => sourceStatus(s, scene, scenes, streamTracks);

  const replace = (next: AudioSource) =>
    setSources((prev) => prev.map((s) => (s.name === next.name ? next : s)));

  // Enables every item for `sourceName` inside the program scene, including nested scenes.
  const showInProgram = (sourceName: string) => {
    const inTree = new Set<string>();
    const collect = (name: string) => {
      if (inTree.has(name)) return;
      inTree.add(name);
      scenes.find((s) => s.name === name)?.items.forEach((i) => i.isScene && collect(i.sourceName));
    };
    collect(programScene);
    setScenes((prev) =>
      prev.map((sc) =>
        inTree.has(sc.name)
          ? { ...sc, items: sc.items.map((i) => (i.sourceName === sourceName ? { ...i, enabled: true } : i)) }
          : sc,
      ),
    );
  };

  const withStatus = sources.map((s) => ({ source: s, status: statusIn(s, programScene) }));
  const heard = withStatus.filter((x) => x.status === "live");
  const silent = heard.filter((x) => !sounding(x.source.name));
  const notHeard = withStatus.filter((x) => x.status !== "live" && x.status !== "notInScene");
  const elsewhere = withStatus.filter((x) => x.status === "notInScene");

  const heardCount = Object.fromEntries(
    mockSwitchableScenes.map((sc) => [sc, sources.filter((s) => statusIn(s, sc) === "live").length]),
  );

  const strip = ({ source, status }: (typeof withStatus)[number]) => (
    <ChannelStrip
      key={source.name}
      source={source}
      status={status}
      sounding={sounding(source.name)}
      levels={levels[source.name] ?? [0, 0]}
      streamTracks={streamTracks}
      onChange={replace}
      onShow={() => showInProgram(source.name)}
    />
  );

  return (
    <div className="app">
      <header className="bar">
        <span className="brand">obs-audio-kit</span>
        <span className="conn">
          <i />
          已連線本機 OBS（假資料）
        </span>
        <span className="spacer" />
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={view === "scene"} onClick={() => setView("scene")}>
            目前場景
          </button>
          <button type="button" role="tab" aria-selected={view === "table"} onClick={() => setView("table")}>
            所有場景對照
          </button>
        </div>
      </header>

      <div className="body">
        <SceneList
          scenes={mockSwitchableScenes}
          programScene={programScene}
          heardCount={heardCount}
          onSwitch={setProgramScene}
        />

        <main className="main">
          {view === "scene" ? (
            <>
              <section className="summary">
                <h2>
                  {programScene}
                  <span className="onair">直播中</span>
                </h2>
                <p>
                  觀眾聽得到 <strong>{heard.length}</strong> 個聲音
                  {silent.length > 0 && <>，其中 {silent.length} 個現在沒有聲音進來</>}
                  {notHeard.length > 0 && <>；另外 {notHeard.length} 個在場景裡但觀眾聽不到</>}。
                </p>
              </section>

              <section>
                <h4 className="section-title">觀眾聽得到</h4>
                <div className="mixer">{heard.map(strip)}</div>
              </section>

              {notHeard.length > 0 && (
                <section>
                  <h4 className="section-title">在這個場景，但觀眾聽不到</h4>
                  <div className="mixer">{notHeard.map(strip)}</div>
                </section>
              )}

              {elsewhere.length > 0 && (
                <section>
                  <h4 className="section-title">其他場景的聲音</h4>
                  <ul className="elsewhere">
                    {elsewhere.map(({ source }) => {
                      const where = scenesContaining(source, scenes).filter((n) => mockSwitchableScenes.includes(n));
                      return (
                        <li key={source.name}>
                          <div>
                            <div className="src-name">{source.name}</div>
                            <div className="dev">{source.device}</div>
                          </div>
                          <div className="where">
                            在
                            {where.map((n) => (
                              <button key={n} type="button" className="chip" onClick={() => setProgramScene(n)}>
                                切到{n}
                              </button>
                            ))}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}
            </>
          ) : (
            <SceneTable
              sources={sources}
              scenes={mockSwitchableScenes}
              programScene={programScene}
              statusIn={statusIn}
              onSwitch={setProgramScene}
            />
          )}
        </main>
      </div>
    </div>
  );
}
