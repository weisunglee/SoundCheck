import { useMemo, useRef, useState } from "react";
import { type AddSourceStart, AddSourceWizard } from "./components/AddSourceWizard";
import { ChannelStrip } from "./components/ChannelStrip";
import { ConnectionGuide } from "./components/ConnectionGuide";
import { FilterWizard } from "./components/FilterWizard";
import { Icon, IconButton } from "./components/Icon";
import { PluginInstall } from "./components/PluginInstall";
import { ProfilesDialog } from "./components/ProfilesDialog";
import { SceneList } from "./components/SceneList";
import { SceneTable } from "./components/SceneTable";
import { SoftwarePicker } from "./components/SoftwarePicker";
import { SoundTest } from "./components/SoundTest";
import { StreamlabsPluginInstall } from "./components/StreamlabsPluginInstall";
import { statusLabel } from "./components/StatusBadge";
import { StreamMeter } from "./components/StreamMeter";
import { SystemSounds } from "./components/SystemSounds";
import { UpdateDialog } from "./components/UpdateDialog";
import { VoiceTuning } from "./components/VoiceTuning";
import { capabilitiesOf } from "./adapter";
import { useAudio } from "./audio";
import { useConnection } from "./connection";
import { obsAdapter } from "./obsAdapter";
import { assessPlugin, createPlugin, pluginApplies, usePluginFiles, usePluginInfo } from "./plugin";
import { streamlabsAdapter } from "./streamlabsAdapter";
import { SoundHold, type SourceWithStatus, itemsToHide, itemsToShow, programAudibility, scenesContaining, sourceStatus } from "./status";
import { useStreamTap } from "./streamTap";
import { type ThemeChoice, useTheme } from "./theme";
import { useUpdater } from "./updater";
import type { SoftwareId } from "./software";
import type { AudioSource } from "./types";
import { LANGUAGES, type Lang, t, useLanguage } from "./i18n";

type View = "scene" | "table";

export default function App() {
  // Subscribing here re-renders the whole app when the language changes.
  const { lang, setLang } = useLanguage();
  const [theme, setTheme] = useTheme();
  const [view, setView] = useState<View>("scene");
  const [soundTestOpen, setSoundTestOpen] = useState(false);
  // The software the install dialog is for, fixed when it opens: it must not switch to OBS's
  // steps when the user closes Streamlabs as the dialog asks.
  const [pluginFor, setPluginFor] = useState<SoftwareId | null>(null);
  const [filtersFor, setFiltersFor] = useState<string | null>(null);
  const [voiceFor, setVoiceFor] = useState<string | null>(null);
  const [addStart, setAddStart] = useState<AddSourceStart | null>(null);
  const [soundTestPlaying, setSoundTestPlaying] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [flashing, setFlashing] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The prompt at start waits until a sound test or voice tuning is closed.
  const updater = useUpdater(soundTestOpen || voiceFor !== null);

  // Scrolls to a source's card and highlights it briefly; the layout itself never changes.
  const jumpTo = (name: string) => {
    document.getElementById(stripId(name))?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashing(name);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashing(null), 1600);
  };
  const { state: connection, presence } = useConnection();
  const software = connection.kind === "connected" ? connection.software : null;
  const audio = useAudio(software === "obs" ? obsAdapter : software === "streamlabs" ? streamlabsAdapter : null);
  const { adapter, state, levels } = audio;
  const plugin = useMemo(() => (adapter?.plugin ? createPlugin(adapter.plugin) : null), [adapter]);
  // Before connecting, the OBS installer applies (it doesn't need a connection).
  const pluginFiles = usePluginFiles(software ?? "obs", 5000);
  // Asked again when a new file is installed: Streamlabs can load it without a restart.
  const pluginInfo = usePluginInfo(state !== null ? plugin : null, pluginFiles?.installedVersion);
  const pluginLoaded = Boolean(pluginInfo);
  // While nothing is connected, show what OBS (the fully supported one) offers.
  const caps = capabilitiesOf(adapter ?? obsAdapter, pluginLoaded);
  const local = connection.kind === "connected" && connection.local;
  const streamTap = useStreamTap(local && pluginLoaded ? plugin : null);
  // The installer is for software on this computer only.
  const need = pluginFiles && pluginApplies(connection) ? assessPlugin(pluginFiles, pluginInfo?.pluginVersion ?? null, pluginInfo !== undefined).need : "none";
  const openPluginDialog = () => setPluginFor(connection.kind === "connecting" ? "obs" : connection.software);
  const NEED_LABELS = { install: t("安裝外掛"), update: t("更新外掛 {version}", { version: pluginFiles?.bundledVersion ?? "" }), notLoaded: t("外掛沒有載入") } as const;

  const soundHold = useRef(new SoundHold()).current;
  const sounding = soundHold.observe(levels, caps.meters, performance.now());

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
            <Icon name="plus" size={15} />
            {t("新增聲音")}
          </button>
          {caps.profiles && (
            <button type="button" className="btn" onClick={() => setProfilesOpen(true)}>
              <Icon name="bookmark" size={15} />
              {t("設定檔")}
            </button>
          )}
        </>
      )}
      {need !== "none" && (
        <button type="button" className="btn warn" onClick={() => openPluginDialog()}>
          <Icon name="download" size={15} />
          {NEED_LABELS[need]}
        </button>
      )}
      {need === "none" && pluginFiles && pluginApplies(connection) && (pluginFiles.installed || pluginFiles.legacyInstalled) && (
        // Nothing to do, but the dialog is where the plugin can be removed.
        <IconButton icon="plug" label={t("直播軟體外掛")} onClick={() => openPluginDialog()} />
      )}
      {caps.plugin && (
      <button
        type="button"
        className="btn primary"
        disabled={!pluginLoaded || !local}
        title={
          !state ? t("連上直播軟體後才能試音") : !local ? t("直播軟體在另一台電腦時無法試音") : !pluginLoaded ? t("試音需要 SoundCheck 外掛") : undefined
        }
        onClick={() => setSoundTestOpen(true)}
      >
        <Icon name="audio-lines" size={15} />
        {t("試音")}
      </button>
      )}
      <SoftwarePicker compact />
      {updater.pending ? (
        <button type="button" className="btn warn" onClick={updater.show}>
          <Icon name="circle-arrow-up" size={15} />
          {t("新版本 {version}", { version: updater.pending })}
        </button>
      ) : (
        <IconButton icon="circle-arrow-up" label={t("檢查更新")} onClick={updater.checkNow} />
      )}
      <label className="with-icon" title={t("主題")}>
        <Icon name="sun-moon" size={15} />
        <select className="select" aria-label={t("主題")} value={theme} onChange={(e) => setTheme(e.target.value as ThemeChoice)}>
          <option value="system">{t("跟隨系統")}</option>
          <option value="light">{t("淺色")}</option>
          <option value="dark">{t("深色")}</option>
        </select>
      </label>
      <label className="with-icon" title={t("語言")}>
        <Icon name="globe" size={15} />
        <select className="select" aria-label={t("語言")} value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
          {LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      </label>
    </header>
  );

  // Rendered right after the header in both layouts below, so React keeps the dialog (and an
  // install in progress) when the app switches between "not connected" and the mixer.
  // What the dialog's software has loaded; nothing while the app is connected to the other one.
  const dialogLoaded = software === pluginFor ? (pluginInfo?.pluginVersion ?? null) : null;
  const pluginDialog =
    pluginFor &&
    (pluginFor === "streamlabs" ? (
      <StreamlabsPluginInstall loadedVersion={dialogLoaded} onClose={() => setPluginFor(null)} />
    ) : (
      <PluginInstall obsConnected={software === "obs" && state !== null} loadedVersion={dialogLoaded} onClose={() => setPluginFor(null)} />
    )
  );

  const updateDialog = updater.open && <UpdateDialog updater={updater} />;

  if (!state) {
    return (
      <div className="app">
        {header}
        {pluginDialog}
        {updateDialog}
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

  const { inScene, heard, silent, notHeard, elsewhere, heardCount } = programAudibility(state, sounding);

  const strip = ({ source, status }: SourceWithStatus) => (
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
      onVisible={(visible) =>
        audio.setItemsVisible(visible ? itemsToShow(programScene, source.name, scenes) : itemsToHide(programScene, source.name, scenes), visible)
      }
    />
  );

  return (
    <div className="app">
      {header}
      {pluginDialog}
      {updateDialog}
      {audio.error && <div className="error-bar">{audio.error}</div>}
      {local && caps.plugin && pluginInfo === null && (
        <div className="notice-bar">
          {t("直播軟體沒有載入 SoundCheck 外掛：試音無法使用，「沒送到直播」先假設直播用的是音軌 1。")}
          {need !== "none" && (
            <button type="button" className="link" onClick={() => openPluginDialog()}>
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
                pluginLoaded={pluginInfo !== null}
                streamPaused={soundTestPlaying}
                sources={sources}
                onInstallPlugin={() => openPluginDialog()}
              />
              )}

              {inScene.length > 0 && (
                <section>
                  <h4 className="section-title">{t("這個場景的聲音（淡色虛線框的觀眾聽不到）")}</h4>
                  <div className="mixer">{inScene.map(strip)}</div>
                </section>
              )}

              {local && adapter && <SystemSounds adapter={adapter} sources={sources} onAdd={setAddStart} />}

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

      {soundTestOpen && plugin && <SoundTest plugin={plugin} onPlayingChange={setSoundTestPlaying} onClose={() => setSoundTestOpen(false)} />}
      {profilesOpen && adapter && <ProfilesDialog adapter={adapter} sources={sources} onClose={() => setProfilesOpen(false)} />}
      {addStart && adapter && (
        <AddSourceWizard
          adapter={adapter}
          sources={sources}
          sceneOrder={sceneOrder}
          programScene={programScene}
          start={addStart}
          local={local}
          onClose={() => setAddStart(null)}
        />
      )}
      {filtersFor && adapter?.filters && (
        <FilterWizard
          ops={adapter.filters}
          sourceName={filtersFor}
          onVoiceTuning={caps.voiceTuning ? () => setVoiceFor(filtersFor) : undefined}
          inputDb={audio.inputDb[filtersFor] ?? null}
          onClose={() => setFiltersFor(null)}
        />
      )}
      {voiceFor && adapter?.filters && sources.some((s) => s.name === voiceFor) && (
        <VoiceTuning
          ops={adapter.filters}
          source={sources.find((s) => s.name === voiceFor)!}
          plugin={plugin}
          needVersion={adapter.voiceFilters ?? ""}
          pluginVersion={pluginInfo === undefined ? undefined : (pluginInfo?.pluginVersion ?? null)}
          canInstall={local}
          onInstallPlugin={() => {
            // The install dialog sits under these two.
            setVoiceFor(null);
            setFiltersFor(null);
            openPluginDialog();
          }}
          onMonitorType={caps.monitoringControl ? (type) => audio.setMonitorType(voiceFor, type) : undefined}
          onClose={() => setVoiceFor(null)}
        />
      )}
    </div>
  );
}

const stripId = (name: string) => `strip-${encodeURIComponent(name)}`;
