import { useRef, useState } from "react";
import { type AddSourceStart, AddSourceWizard } from "./components/AddSourceWizard";
import { ChannelStrip } from "./components/ChannelStrip";
import { ConnectionGuide } from "./components/ConnectionGuide";
import { FilterWizard } from "./components/FilterWizard";
import { PluginInstall } from "./components/PluginInstall";
import { ProfilesDialog } from "./components/ProfilesDialog";
import { SceneList } from "./components/SceneList";
import { SceneTable } from "./components/SceneTable";
import { SoftwarePicker } from "./components/SoftwarePicker";
import { SoundTest } from "./components/SoundTest";
import { statusLabel } from "./components/StatusBadge";
import { StreamMeter } from "./components/StreamMeter";
import { SystemSounds } from "./components/SystemSounds";
import { useConnection } from "./obs";
import { useObsAudio } from "./obsAudio";
import { useStreamlabsAudio } from "./streamlabsAudio";
import { pluginNeed, usePluginStatus } from "./pluginStatus";
import { itemsToShow, scenesContaining, sourceStatus } from "./status";
import { useStreamTap } from "./streamTap";
import type { AudioSource } from "./types";
import { LANGUAGES, type Lang, t, useLanguage } from "./i18n";

/** A meter position above this (about -57 dBFS) counts as "making sound". */
const SOUND_THRESHOLD = 0.05;
/** Keep showing "making sound" this long after the last loud moment, so pauses in speech don't flicker. */
const SOUND_HOLD_MS = 1500;

type View = "scene" | "table";

export default function App() {
  // Subscribing here re-renders the whole app when the language changes.
  const { lang, setLang } = useLanguage();
  const [view, setView] = useState<View>("scene");
  const [soundTestOpen, setSoundTestOpen] = useState(false);
  const [pluginOpen, setPluginOpen] = useState(false);
  const [filtersFor, setFiltersFor] = useState<string | null>(null);
  const [addStart, setAddStart] = useState<AddSourceStart | null>(null);
  const [soundTestPlaying, setSoundTestPlaying] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [flashing, setFlashing] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Scrolls to a source's card and highlights it briefly; the layout itself never changes.
  const jumpTo = (name: string) => {
    document.getElementById(stripId(name))?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashing(name);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashing(null), 1600);
  };
  const { state: connection, presence } = useConnection();
  const software = connection.kind === "connected" ? connection.software : null;
  // Both hooks always run (React's rule); only the one for the connected software is active.
  const obsAudio = useObsAudio(software === "obs");
  const streamlabsAudio = useStreamlabsAudio(software === "streamlabs");
  const audio = software === "streamlabs" ? streamlabsAudio : obsAudio;
  const caps = audio.capabilities;
  const { state, levels } = audio;
  const pluginStatus = usePluginStatus(5000);
  const local = connection.kind === "connected" && connection.local;
  const streamTap = useStreamTap(local && caps.plugin && (state?.pluginAvailable ?? false));
  // The installer is for this computer's OBS only.
  const pluginRelevant = software === "obs" ? local : connection.kind !== "connected" && (connection.kind !== "failed" || connection.software === "obs");
  const need = pluginStatus && pluginRelevant ? pluginNeed(pluginStatus, state?.pluginVersion ?? null, state !== null) : "none";
  const NEED_LABELS = { install: t("安裝外掛"), update: t("更新外掛 {version}", { version: pluginStatus?.bundledVersion ?? "" }), notLoaded: t("外掛沒有載入") } as const;

  const lastSound = useRef<Record<string, number>>({});
  const now = performance.now();
  for (const [name, [l, r]] of Object.entries(levels)) {
    if (Math.max(l, r) > SOUND_THRESHOLD) lastSound.current[name] = now;
  }
  // Without meters there's no way to tell silence, so never claim a source is silent.
  const sounding = (name: string) => !caps.meters || now - (lastSound.current[name] ?? -Infinity) < SOUND_HOLD_MS;

  const header = (
    <header className="bar">
      <span className="brand">SoundCheck</span>
      <span className={`conn conn-${connection.kind}`} title={connection.kind === "failed" ? connection.message : undefined}>
        <i />
        {connection.kind === "connected" &&
          (connection.local
            ? t("已連線直播軟體（{app} {version}）", { version: connection.version })
            : t("已連線另一台電腦的直播軟體（{app} {version}）", { version: connection.version }))}
        {connection.kind === "connecting" && t("正在連線直播軟體…")}
        {connection.kind === "failed" && t("沒有連上直播軟體")}
      </span>
      <span className="spacer" />
      {state && (
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={view === "scene"} onClick={() => setView("scene")}>
            {t("目前場景")}
          </button>
          <button type="button" role="tab" aria-selected={view === "table"} onClick={() => setView("table")}>
            {t("所有場景對照")}
          </button>
        </div>
      )}
      {state && (
        <>
          <button type="button" className="btn" onClick={() => setAddStart({})}>
            {t("＋ 新增聲音")}
          </button>
          {caps.profiles && (
            <button type="button" className="btn" onClick={() => setProfilesOpen(true)}>
              {t("設定檔")}
            </button>
          )}
        </>
      )}
      {need !== "none" && (
        <button type="button" className="btn warn" onClick={() => setPluginOpen(true)}>
          {NEED_LABELS[need]}
        </button>
      )}
      {caps.plugin && (
      <button
        type="button"
        className="btn primary"
        disabled={!state?.pluginAvailable || !local}
        title={
          !state ? t("連上直播軟體後才能試音") : !local ? t("直播軟體在另一台電腦時無法試音") : !state.pluginAvailable ? t("試音需要 SoundCheck 外掛") : undefined
        }
        onClick={() => setSoundTestOpen(true)}
      >
        {t("試音")}
      </button>
      )}
      <SoftwarePicker compact />
      <select className="select" aria-label={t("語言")} value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
        {LANGUAGES.map((l) => (
          <option key={l.id} value={l.id}>
            {l.label}
          </option>
        ))}
      </select>
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
            <ConnectionGuide failure={connection} presence={presence} />
          ) : (
            <p>{audio.error ?? t("正在讀取直播軟體的聲音設定…")}</p>
          )}
        </div>
      </div>
    );
  }

  const { sources, scenes, sceneOrder, programScene, streamTracks } = state;
  const statusIn = (s: AudioSource, scene: string) => sourceStatus(s, scene, scenes, streamTracks);

  const withStatus = sources.map((s) => ({ source: s, status: statusIn(s, programScene) }));
  // One list in a fixed order (global devices first, then OBS's own order), so a card never
  // moves when its status changes and muting can be undone with a second click in the same spot.
  const inScene = [
    ...withStatus.filter((x) => x.status !== "notInScene" && x.source.global),
    ...withStatus.filter((x) => x.status !== "notInScene" && !x.source.global),
  ];
  const heard = inScene.filter((x) => x.status === "live");
  const silent = heard.filter((x) => !sounding(x.source.name));
  const notHeard = inScene.filter((x) => x.status !== "live");
  const elsewhere = withStatus.filter((x) => x.status === "notInScene");

  const heardCount = Object.fromEntries(sceneOrder.map((sc) => [sc, sources.filter((s) => statusIn(s, sc) === "live").length]));

  const strip = ({ source, status }: (typeof withStatus)[number]) => (
    <ChannelStrip
      key={source.name}
      id={stripId(source.name)}
      flash={flashing === source.name}
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
      caps={caps}
      onAddStreamTracks={() => audio.addStreamTracks(source.name)}
      onShow={() => audio.showInProgram(itemsToShow(programScene, source.name, scenes))}
    />
  );

  return (
    <div className="app">
      {header}
      {pluginDialog}
      {audio.error && <div className="error-bar">{audio.error}</div>}
      {local && caps.plugin && !state.pluginAvailable && (
        <div className="notice-bar">
          {t("直播軟體沒有載入 SoundCheck 外掛：試音無法使用，「沒送到直播」先假設直播用的是音軌 1。")}
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
                  <span className="onair">{t("直播中")}</span>
                </h2>
                <p>
                  {t("觀眾聽得到 {n} 個聲音", { n: heard.length })}
                  {silent.length > 0 && t("，其中 {n} 個現在沒有聲音進來", { n: silent.length })}
                  {notHeard.length > 0 && t("；另外 {n} 個在場景裡但觀眾聽不到", { n: notHeard.length })}
                  {t("。")}
                </p>
                {(notHeard.length > 0 || silent.length > 0) && (
                  <div className="jump-list">
                    {notHeard.map(({ source, status }) => (
                      <button key={source.name} type="button" className="chip jump" onClick={() => jumpTo(source.name)}>
                        {t("{source}：{status}", { source: source.name, status: statusLabel(status) })}
                      </button>
                    ))}
                    {silent.map(({ source }) => (
                      <button key={source.name} type="button" className="chip jump quiet" onClick={() => jumpTo(source.name)}>
                        {t("{source}：{status}", { source: source.name, status: statusLabel("silent") })}
                      </button>
                    ))}
                  </div>
                )}
              </section>

              {local && caps.plugin && (
              <StreamMeter
                level={streamTap.level}
                running={streamTap.running}
                pluginLoaded={state.pluginAvailable}
                streamPaused={soundTestPlaying}
                sources={sources}
                onInstallPlugin={() => setPluginOpen(true)}
              />
              )}

              {inScene.length > 0 && (
                <section>
                  <h4 className="section-title">{t("這個場景的聲音（淡色虛線框的觀眾聽不到）")}</h4>
                  <div className="mixer">{inScene.map(strip)}</div>
                </section>
              )}

              {!caps.plugin && (
                <p className="hint notice-inline">
                  {t("{app} 不提供音量表、濾鏡、監聽和音軌的設定，也不能裝外掛，所以這些功能在 {app} 上無法使用；音量、靜音和場景可以正常調整。")}
                </p>
              )}

              {local && <SystemSounds backend={audio} sources={sources} onAdd={setAddStart} />}

              {elsewhere.length > 0 && (
                <section>
                  <h4 className="section-title">{t("其他場景的聲音")}</h4>
                  <ul className="elsewhere">
                    {elsewhere.map(({ source }) => {
                      const where = scenesContaining(source, scenes).filter((n) => sceneOrder.includes(n));
                      return (
                        <li key={source.name}>
                          <div>
                            <div className="src-name">{source.name}</div>
                            <div className="dev">{t(source.device)}</div>
                          </div>
                          <div className="where">
                            {where.length === 0
                              ? t("沒有放在任何場景裡")
                              : where.map((n) => (
                                  <button key={n} type="button" className="chip" onClick={() => audio.switchScene(n)}>
                                    {t("切到{scene}", { scene: n })}
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
          backend={audio}
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

const stripId = (name: string) => `strip-${encodeURIComponent(name)}`;
