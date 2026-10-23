import { useRef, useState } from "react";
import { type AddSourceStart, AddSourceWizard } from "./components/AddSourceWizard";
import { ChannelStrip } from "./components/ChannelStrip";
import { ConnectionGuide } from "./components/ConnectionGuide";
import { FilterWizard } from "./components/FilterWizard";
import { PluginInstall } from "./components/PluginInstall";
import { ProfilesDialog } from "./components/ProfilesDialog";
import { SceneList } from "./components/SceneList";
import { SceneTable } from "./components/SceneTable";
import { SoundTest } from "./components/SoundTest";
import { StreamMeter } from "./components/StreamMeter";
import { SystemSounds } from "./components/SystemSounds";
import { useObsConnection } from "./obs";
import { useObsAudio } from "./obsAudio";
import { pluginNeed, usePluginStatus } from "./pluginStatus";
import { itemsToShow, scenesContaining, sourceStatus } from "./status";
import { useStreamTap } from "./streamTap";
import type { AudioSource } from "./types";

/** A meter position above this (about -57 dBFS) counts as "making sound". */
const SOUND_THRESHOLD = 0.05;
/** Keep showing "making sound" this long after the last loud moment, so pauses in speech don't flicker. */
const SOUND_HOLD_MS = 1500;

type View = "scene" | "table";

export default function App() {
  const [view, setView] = useState<View>("scene");
  const [soundTestOpen, setSoundTestOpen] = useState(false);
  const [pluginOpen, setPluginOpen] = useState(false);
  const [filtersFor, setFiltersFor] = useState<string | null>(null);
  const [addStart, setAddStart] = useState<AddSourceStart | null>(null);
  const [soundTestPlaying, setSoundTestPlaying] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const connection = useObsConnection();
  const audio = useObsAudio(connection.kind === "connected");
  const { state, levels } = audio;
  const pluginStatus = usePluginStatus(5000);
  const local = connection.kind === "connected" && connection.local;
  const streamTap = useStreamTap(local && (state?.pluginAvailable ?? false));
  // The installer works on this computer's OBS only.
  const need = pluginStatus && (local || connection.kind !== "connected") ? pluginNeed(pluginStatus, state?.pluginVersion ?? null, state !== null) : "none";
  const NEED_LABELS = { install: "安裝外掛", update: `更新外掛 ${pluginStatus?.bundledVersion}`, notLoaded: "外掛沒有載入" } as const;

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
        {connection.kind === "connected" && `已連線${connection.local ? "本機" : "另一台電腦的"} OBS ${connection.obsVersion}`}
        {connection.kind === "connecting" && "正在連線 OBS…"}
        {connection.kind === "failed" && "沒有連上 OBS"}
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
      {state && (
        <>
          <button type="button" className="btn" onClick={() => setAddStart({})}>
            ＋ 新增聲音
          </button>
          <button type="button" className="btn" onClick={() => setProfilesOpen(true)}>
            設定檔
          </button>
        </>
      )}
      {need !== "none" && (
        <button type="button" className="btn warn" onClick={() => setPluginOpen(true)}>
          {NEED_LABELS[need]}
        </button>
      )}
      <button
        type="button"
        className="btn primary"
        disabled={!state?.pluginAvailable || !local}
        title={
          !state ? "連上 OBS 後才能試音" : !local ? "OBS 在另一台電腦時無法試音" : !state.pluginAvailable ? "試音需要 obs-audio-kit 外掛" : undefined
        }
        onClick={() => setSoundTestOpen(true)}
      >
        試音
      </button>
    </header>
  );

  // Rendered right after the header in both layouts below, so React keeps the dialog (and an
  // install in progress) when the app switches between "not connected" and the mixer.
  const pluginDialog = pluginOpen && (
    <PluginInstall obsConnected={state !== null} loadedVersion={state?.pluginVersion ?? null} onClose={() => setPluginOpen(false)} />
  );

  if (!state) {
    return (
      <div className="app">
        {header}
        {pluginDialog}
        <div className="empty">
          {connection.kind === "failed" ? (
            <ConnectionGuide failure={connection} obsRunning={pluginStatus?.obsRunning ?? null} />
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
      onBalance={(b) => audio.setBalance(source.name, b)}
      onSyncOffset={(ms) => audio.setSyncOffset(source.name, ms)}
      onFilterEnabled={(f, on) => audio.setFilterEnabled(source.name, f, on)}
      onOpenFilters={() => setFiltersFor(source.name)}
      onAddStreamTracks={() => audio.addStreamTracks(source.name)}
      onShow={() => audio.showInProgram(itemsToShow(programScene, source.name, scenes))}
    />
  );

  return (
    <div className="app">
      {header}
      {pluginDialog}
      {audio.error && <div className="error-bar">{audio.error}</div>}
      {local && !state.pluginAvailable && (
        <div className="notice-bar">
          OBS 沒有載入 obs-audio-kit 外掛：試音無法使用，「沒送到直播」先假設直播用的是音軌 1。
          {need !== "none" && (
            <button type="button" className="link" onClick={() => setPluginOpen(true)}>
              {NEED_LABELS[need]}
            </button>
          )}
        </div>
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

              {local && (
              <StreamMeter
                level={streamTap.level}
                running={streamTap.running}
                pluginLoaded={state.pluginAvailable}
                streamPaused={soundTestPlaying}
                sources={sources}
                onInstallPlugin={() => setPluginOpen(true)}
              />
              )}

              {local && <SystemSounds sources={sources} onAdd={setAddStart} />}

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

      {soundTestOpen && <SoundTest onPlayingChange={setSoundTestPlaying} onClose={() => setSoundTestOpen(false)} />}
      {profilesOpen && <ProfilesDialog sources={sources} onClose={() => setProfilesOpen(false)} />}
      {addStart && (
        <AddSourceWizard
          sources={sources}
          sceneOrder={sceneOrder}
          programScene={programScene}
          start={addStart}
          local={local}
          onClose={() => setAddStart(null)}
        />
      )}
      {filtersFor && <FilterWizard sourceName={filtersFor} inputDb={audio.inputDb[filtersFor] ?? null} onClose={() => setFiltersFor(null)} />}
    </div>
  );
}
