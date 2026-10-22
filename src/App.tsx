import { useRef, useState } from "react";
import { ChannelStrip } from "./components/ChannelStrip";
import { SceneList } from "./components/SceneList";
import { SceneTable } from "./components/SceneTable";
import { SoundTest } from "./components/SoundTest";
import { useObsConnection } from "./obs";
import { useObsAudio } from "./obsAudio";
import { itemsToShow, scenesContaining, sourceStatus } from "./status";
import type { AudioSource } from "./types";

/** A meter position above this (about -57 dBFS) counts as "making sound". */
const SOUND_THRESHOLD = 0.05;
/** Keep showing "making sound" this long after the last loud moment, so pauses in speech don't flicker. */
const SOUND_HOLD_MS = 1500;

type View = "scene" | "table";

export default function App() {
  const [view, setView] = useState<View>("scene");
  const [soundTestOpen, setSoundTestOpen] = useState(false);
  const connection = useObsConnection();
  const audio = useObsAudio(connection.kind === "connected");
  const { state, levels } = audio;

  const lastSound = useRef<Record<string, number>>({});
  const now = performance.now();
  for (const [name, [l, r]] of Object.entries(levels)) {
    if (Math.max(l, r) > SOUND_THRESHOLD) lastSound.current[name] = now;
  }
  const sounding = (name: string) => now - (lastSound.current[name] ?? -Infinity) < SOUND_HOLD_MS;

  const header = (
    <header className="bar">
      <span className="brand">obs-audio-kit</span>
      <span className={`conn conn-${connection.kind}`} title={connection.kind === "failed" ? connection.message : undefined}>
        <i />
        {connection.kind === "connected" && `已連線本機 OBS ${connection.obsVersion}`}
        {connection.kind === "connecting" && "正在連線 OBS…"}
        {connection.kind === "failed" && connection.message}
      </span>
      <span className="spacer" />
      {state && (
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={view === "scene"} onClick={() => setView("scene")}>
            目前場景
          </button>
          <button type="button" role="tab" aria-selected={view === "table"} onClick={() => setView("table")}>
            所有場景對照
          </button>
        </div>
      )}
      <button
        type="button"
        className="btn primary"
        disabled={!state?.pluginAvailable}
        title={!state ? "連上 OBS 後才能試音" : !state.pluginAvailable ? "試音需要 obs-audio-kit 外掛" : undefined}
        onClick={() => setSoundTestOpen(true)}
      >
        試音
      </button>
    </header>
  );

  if (!state) {
    return (
      <div className="app">
        {header}
        <div className="empty">
          {connection.kind === "failed" ? (
            <>
              <h2>還沒連上 OBS</h2>
              <p>{connection.message}</p>
            </>
          ) : (
            <p>{audio.error ?? "正在讀取 OBS 的聲音設定…"}</p>
          )}
        </div>
      </div>
    );
  }

  const { sources, scenes, sceneOrder, programScene, streamTracks } = state;
  const statusIn = (s: AudioSource, scene: string) => sourceStatus(s, scene, scenes, streamTracks);

  const withStatus = sources.map((s) => ({ source: s, status: statusIn(s, programScene) }));
  const heard = withStatus.filter((x) => x.status === "live");
  const silent = heard.filter((x) => !sounding(x.source.name));
  const notHeard = withStatus.filter((x) => x.status !== "live" && x.status !== "notInScene");
  const elsewhere = withStatus.filter((x) => x.status === "notInScene");

  const heardCount = Object.fromEntries(sceneOrder.map((sc) => [sc, sources.filter((s) => statusIn(s, sc) === "live").length]));

  const strip = ({ source, status }: (typeof withStatus)[number]) => (
    <ChannelStrip
      key={source.name}
      source={source}
      status={status}
      sounding={sounding(source.name)}
      levels={levels[source.name] ?? [0, 0]}
      streamTracks={streamTracks}
      onVolume={(db) => audio.setVolume(source.name, db)}
      onMuted={(m) => audio.setMuted(source.name, m)}
      onMonitorType={(t) => audio.setMonitorType(source.name, t)}
      onFilterEnabled={(f, on) => audio.setFilterEnabled(source.name, f, on)}
      onAddStreamTracks={() => audio.addStreamTracks(source.name)}
      onShow={() => audio.showInProgram(itemsToShow(programScene, source.name, scenes))}
    />
  );

  return (
    <div className="app">
      {header}
      {audio.error && <div className="error-bar">{audio.error}</div>}
      {!state.pluginAvailable && (
        <div className="notice-bar">沒有偵測到 obs-audio-kit 外掛：試音無法使用，「沒送到直播」先假設直播用的是音軌 1。</div>
      )}

      <div className="body">
        <SceneList scenes={sceneOrder} programScene={programScene} heardCount={heardCount} onSwitch={audio.switchScene} />

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

              {heard.length > 0 && (
                <section>
                  <h4 className="section-title">觀眾聽得到</h4>
                  <div className="mixer">{heard.map(strip)}</div>
                </section>
              )}

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
                      const where = scenesContaining(source, scenes).filter((n) => sceneOrder.includes(n));
                      return (
                        <li key={source.name}>
                          <div>
                            <div className="src-name">{source.name}</div>
                            <div className="dev">{source.device}</div>
                          </div>
                          <div className="where">
                            {where.length === 0
                              ? "沒有放在任何場景裡"
                              : where.map((n) => (
                                  <button key={n} type="button" className="chip" onClick={() => audio.switchScene(n)}>
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
            <SceneTable sources={sources} scenes={sceneOrder} programScene={programScene} statusIn={statusIn} onSwitch={audio.switchScene} />
          )}
        </main>
      </div>

      {soundTestOpen && <SoundTest onClose={() => setSoundTestOpen(false)} />}
    </div>
  );
}
