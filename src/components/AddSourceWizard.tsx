import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { CaptureSettings, SoftwareAdapter } from "../adapter";
import {
  CAPTURE_KINDS,
  type SystemApp,
  type SystemDevice,
  appCoverage,
  appLabel,
  deviceCoverage,
  obsWindowString,
  useSystemAudio,
} from "../systemAudio";
import type { AudioSource } from "../types";
import { msg, t } from "../i18n";

export type SoundKind = "input" | "output" | "app";

/** Where the wizard can start: a kind, optionally with the device or app already picked. */
export interface AddSourceStart {
  kind?: SoundKind;
  deviceId?: string;
  app?: SystemApp;
}

interface Props {
  adapter: SoftwareAdapter;
  sources: AudioSource[];
  sceneOrder: string[];
  programScene: string;
  start?: AddSourceStart;
  /** False when OBS runs on another computer: this computer's devices and apps would be wrong there. */
  local: boolean;
  onClose: () => void;
}

const KIND_CHOICES: { kind: SoundKind; title: string; detail: string }[] = [
  { kind: "input", title: msg("麥克風或其他輸入"), detail: msg("麥克風、混音器、擷取卡的聲音輸入") },
  { kind: "output", title: msg("電腦播放的所有聲音"), detail: msg("整台電腦從某個喇叭或耳機播出的聲音") },
  { kind: "app", title: msg("某個應用程式的聲音"), detail: msg("只收一個程式，例如遊戲、Spotify、Discord") },
];

/** "default" asks OBS to follow whatever the system default device is. */
const DEFAULT_DEVICE = "default";
/** How long a microphone preview stays open (matches the backend's limit). */
const LISTEN_LIMIT_MS = 30_000;
/** OBS app capture matches the window by executable name (window_priority: class 0, title 1, exe 2). */
const MATCH_BY_EXE = 2;

type Pick = { kind: "input" | "output"; deviceId: string; name: string } | { kind: "app"; app: SystemApp; name: string };

export function AddSourceWizard({ adapter, sources, sceneOrder, programScene, start, local, onClose }: Props) {
  const [kind, setKind] = useState<SoundKind | null>(start?.kind ?? null);
  const [pick, setPick] = useState<Pick | null>(null);
  const [name, setName] = useState("");
  const [allScenes, setAllScenes] = useState(false);
  const [availableKinds, setAvailableKinds] = useState<Set<string> | null>(null);
  const [captures, setCaptures] = useState<CaptureSettings>(new Map());
  const [status, setStatus] = useState<{ kind: "idle" } | { kind: "adding" } | { kind: "done"; name: string } | { kind: "error"; message: string }>({
    kind: "idle",
  });
  const [listening, setListening] = useState<string | null>(null);
  const [listenError, setListenError] = useState<string | null>(null);
  // Poll faster while previewing a microphone, so its meter reacts to speech.
  const system = useSystemAudio(local, listening ? 150 : 500);
  const startApplied = useRef(false);
  const listenTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const stopListening = () => {
    clearTimeout(listenTimer.current);
    setListening(null);
    invoke("device_listen_stop").catch(() => {});
  };
  const toggleListen = (id: string) => {
    if (listening === id) return stopListening();
    setListenError(null);
    invoke("device_listen_start", { id })
      .then(() => {
        setListening(id);
        clearTimeout(listenTimer.current);
        // The backend also closes the device after 30 s; keep the button in step with it.
        listenTimer.current = setTimeout(() => setListening(null), LISTEN_LIMIT_MS);
      })
      .catch((e: string) => setListenError(e));
  };
  useEffect(() => () => {
    clearTimeout(listenTimer.current);
    invoke("device_listen_stop").catch(() => {});
  }, []);

  useEffect(() => {
    adapter
      .listInputKinds()
      .then(setAvailableKinds)
      .catch(() => setAvailableKinds(new Set()));
  }, []);
  useEffect(() => {
    adapter.captureSettings(sources).then(setCaptures);
  }, [sources]);

  const obsKind = (k: SoundKind) => CAPTURE_KINDS[k].find((x) => availableKinds?.has(x)) ?? null;
  const devices = system?.devices ?? [];

  const choose = (p: Pick) => {
    setPick(p);
    setName(uniqueName(p.name, sources));
  };

  // Jump straight to the confirm step once when the wizard was opened for a specific device or app;
  // after that, going back must stay back.
  useEffect(() => {
    if (startApplied.current || !start) return;
    if (start.app) {
      startApplied.current = true;
      choose({ kind: "app", app: start.app, name: appLabel(start.app) });
    } else if (start.deviceId && start.kind && start.kind !== "app") {
      const device = devices.find((d) => d.id === start.deviceId);
      if (device) {
        startApplied.current = true;
        choose({ kind: start.kind, deviceId: device.id, name: device.name });
      }
    } else {
      startApplied.current = true;
    }
  }, [start, devices]);

  const add = async () => {
    if (!pick) return;
    stopListening();
    const inputKind = obsKind(pick.kind);
    if (!inputKind) return;
    setStatus({ kind: "adding" });
    try {
      const inputName = name.trim();
      const inputSettings: { [key: string]: string | number } =
        pick.kind === "app" ? { window: obsWindowString(pick.app), priority: MATCH_BY_EXE } : { device_id: pick.deviceId };
      const targets = allScenes ? sceneOrder : [programScene];
      await adapter.createSource(inputName, inputKind, inputSettings, targets);
      setStatus({ kind: "done", name: inputName });
    } catch (e) {
      setStatus({ kind: "error", message: t("直播軟體沒有建立這個來源：{error}", { error: (e as Error).message }) });
    }
  };

  const nameTaken = sources.some((s) => s.name === name.trim());

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="add-title">
      <div className="dialog wide">
        <div className="dialog-head">
          <h2 id="add-title">{t("新增聲音到直播軟體")}</h2>
          <button type="button" className="link" onClick={onClose}>
            {t("關閉")}
          </button>
        </div>

        {status.kind === "done" ? (
          <>
            <div className="verdict verdict-ok">
              {allScenes
                ? t("已經把「{name}」加到所有場景。", { name: status.name })
                : t("已經把「{name}」加到「{scene}」。", { name: status.name, scene: programScene })}
            </div>
            <div className="row">
              <button type="button" className="btn primary" onClick={onClose}>
                {t("完成")}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setStatus({ kind: "idle" });
                  setPick(null);
                  setKind(null);
                }}
              >
                {t("再加一個")}
              </button>
            </div>
          </>
        ) : !kind ? (
          <section className="wizard-section">
            <h4 className="section-title">{t("你想加入什麼聲音？")}</h4>
            <div className="problems">
              {KIND_CHOICES.map((c) => {
                // Apps can only be listed for an OBS on this computer.
                const supported = (availableKinds === null || obsKind(c.kind) !== null) && (local || c.kind !== "app");
                return (
                  <button key={c.kind} type="button" className="problem" disabled={!supported} onClick={() => setKind(c.kind)}>
                    <span className="problem-title">{t(c.title)}</span>
                    <span className="problem-detail">
                      {supported ? t(c.detail) : local ? t("這台電腦的直播軟體不支援") : t("直播軟體在另一台電腦時無法使用")}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ) : !pick ? (
          <section className="wizard-section">
            <div className="row">
              <button type="button" className="link" onClick={() => setKind(null)}>
                {t("← 換一種聲音")}
              </button>
            </div>
            <h4 className="section-title">{kind === "app" ? t("選擇應用程式") : t("選擇裝置")}</h4>
            {kind === "app" ? (
              <AppList apps={system?.apps ?? []} supported={system?.supported ?? true} captures={captures} devices={devices} onPick={(app) => choose({ kind: "app", app, name: appLabel(app) })} />
            ) : (
              <DeviceList
                flow={kind === "input" ? "capture" : "render"}
                devices={local ? devices : []}
                captures={captures}
                listening={listening}
                onListen={local && kind === "input" ? toggleListen : undefined}
                onPick={(deviceId, deviceName) => {
                  stopListening();
                  choose({ kind, deviceId, name: deviceName });
                }}
              />
            )}
          </section>
        ) : (
          <section className="wizard-section">
            <div className="row">
              <button type="button" className="link" onClick={() => setPick(null)}>
                {t("← 重新選擇")}
              </button>
            </div>
            {pick.kind === "input" && pick.deviceId !== DEFAULT_DEVICE && local && (
              <div className="field">
                <span className="field-label">{t("確認是這個裝置")}</span>
                <div className="pick-row">
                  <span className="pick-title">{devices.find((d) => d.id === pick.deviceId)?.name ?? pick.name}</span>
                  <button type="button" className="btn small" onClick={() => toggleListen(pick.deviceId)}>
                    {listening === pick.deviceId ? t("停止試聽") : t("試聽")}
                  </button>
                </div>
                {listening === pick.deviceId && <Peak value={devices.find((d) => d.id === pick.deviceId)?.peak ?? 0} />}
                <span className="hint">{t("按「試聽」後對著它說話，音量條有跳就是這一個。試聽時 Windows 會顯示麥克風使用中。")}</span>
              </div>
            )}
            {listenError && <div className="verdict verdict-bad">{listenError}</div>}
            <label className="field">
              <span className="field-label">{t("在直播軟體裡的名稱")}</span>
              <input id="add-name" className="text-input" value={name} onChange={(e) => setName(e.target.value)} />
              {nameTaken && <span className="hint">{t("直播軟體裡已經有這個名稱，請換一個。")}</span>}
            </label>
            <div className="field">
              <span className="field-label">{t("要加到哪裡？")}</span>
              <label className="radio">
                <input type="radio" name="add-where" checked={!allScenes} onChange={() => setAllScenes(false)} />
                {t("只有目前的場景「{scene}」", { scene: programScene })}
              </label>
              <label className="radio">
                <input type="radio" name="add-where" checked={allScenes} onChange={() => setAllScenes(true)} />
                {t("所有場景（{n} 個）", { n: sceneOrder.length })}
              </label>
            </div>
            {status.kind === "error" && <div className="verdict verdict-bad">{status.message}</div>}
            <button type="button" className="btn primary" disabled={status.kind === "adding" || !name.trim() || nameTaken} onClick={add}>
              {status.kind === "adding" ? t("加入中…") : t("加進直播軟體")}
            </button>
          </section>
        )}
      </div>
    </div>
  );
}

function uniqueName(base: string, sources: AudioSource[]): string {
  const taken = new Set(sources.map((s) => s.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

function Peak({ value }: { value: number }) {
  const db = value > 0 ? 20 * Math.log10(value) : -60;
  return (
    <span className="mini-meter" aria-hidden="true">
      <b style={{ width: `${Math.max(0, Math.min(1, (db + 60) / 60)) * 100}%` }} />
    </span>
  );
}

function DeviceList(props: {
  flow: "render" | "capture";
  devices: SystemDevice[];
  captures: CaptureSettings;
  /** Recording device currently opened for a level preview. */
  listening: string | null;
  /** Present when recording devices can be previewed. */
  onListen?: (deviceId: string) => void;
  onPick: (deviceId: string, name: string) => void;
}) {
  const list = props.devices.filter((d) => d.flow === props.flow);
  const defaultLabel = props.flow === "capture" ? t("跟著系統預設的麥克風") : t("跟著系統預設的播放裝置");
  return (
    <ul className="pick-list">
      <li>
        <button type="button" className="pick" onClick={() => props.onPick(DEFAULT_DEVICE, props.flow === "capture" ? t("麥克風") : t("桌面音訊"))}>
          <span className="pick-title">{defaultLabel}</span>
          <span className="pick-detail">{t("換預設裝置時會自動跟著換，最不容易出錯。")}</span>
        </button>
      </li>
      {props.onListen && <li className="hint">{t("不知道是哪一個？按「試聽」再對著麥克風說話，音量條有跳的就是它。")}</li>}
      {list.map((d) => {
        const coverage = deviceCoverage(d, props.captures, props.devices);
        const isListening = props.listening === d.id;
        return (
          <li key={d.id} className="pick-item">
            <button type="button" className="pick" onClick={() => props.onPick(d.id, d.name)}>
              <span className="pick-title">
                {d.name}
                {d.isDefault && <span className="tag">{t("預設")}</span>}
                {isListening && <span className="tag">{t("試聽中")}</span>}
              </span>
              <Peak value={d.peak} />
              {coverage.sources.length > 0 && <span className="pick-detail">{t("已在直播軟體：{list}", { list: coverage.sources.join(t("、")) })}</span>}
            </button>
            {props.onListen && (
              <button type="button" className="btn small" onClick={() => props.onListen!(d.id)}>
                {isListening ? t("停止試聽") : t("試聽")}
              </button>
            )}
          </li>
        );
      })}
      {list.length === 0 && <li className="hint">{t("沒有可以列出的裝置清單（直播軟體在另一台電腦，或這個平台還不支援），請用上面的預設選項。")}</li>}
    </ul>
  );
}

function AppList(props: {
  apps: SystemApp[];
  supported: boolean;
  captures: CaptureSettings;
  devices: SystemDevice[];
  onPick: (app: SystemApp) => void;
}) {
  if (!props.supported) return <p className="hint">{t("這個平台還不支援列出應用程式的聲音。")}</p>;
  const apps = [...props.apps].sort((a, b) => b.peak - a.peak);
  return (
    <>
      <p className="hint">{t("只會列出正在播放聲音的程式。找不到的話，先讓那個程式發出聲音。")}</p>
      <ul className="pick-list">
        {apps.map((a) => {
          const coverage = appCoverage(a, props.captures, props.devices);
          return (
            <li key={`${a.pid}-${a.deviceId}`}>
              <button type="button" className="pick" onClick={() => props.onPick(a)}>
                <span className="pick-title">{appLabel(a)}</span>
                {a.windowTitle && <span className="pick-detail">{a.windowTitle}</span>}
                <Peak value={a.peak} />
                {coverage.sources.length > 0 && (
                  <span className="pick-detail">
                    {coverage.viaDevice
                      ? t("已經透過「{list}」收進直播軟體", { list: coverage.sources.join(t("、")) })
                      : t("已在直播軟體：{list}", { list: coverage.sources.join(t("、")) })}
                  </span>
                )}
              </button>
            </li>
          );
        })}
        {apps.length === 0 && <li className="hint">{t("現在沒有程式在播放聲音。")}</li>}
      </ul>
    </>
  );
}
