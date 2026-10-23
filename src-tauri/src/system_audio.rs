//! What is making sound on this computer right now, independent of OBS.
//!
//! Windows: the same data as the system volume mixer — every active playback
//! and recording device, and every app's audio session with its live peak.
//! Other platforms report `supported: false` for now.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    /// Endpoint ID; OBS stores the same string as `device_id`.
    pub id: String,
    pub name: String,
    /// "render" (speakers, headphones) or "capture" (microphones, line in).
    pub flow: &'static str,
    pub is_default: bool,
    /// Current peak, 0..1. Capture devices only report a level while some app records from them.
    pub peak: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioApp {
    pub pid: u32,
    /// Executable file name, e.g. "Spotify.exe".
    pub exe: String,
    /// Title of the app's main window, if it has one.
    pub window_title: Option<String>,
    pub window_class: Option<String>,
    /// Render device the app plays to.
    pub device_id: String,
    pub peak: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAudio {
    pub supported: bool,
    pub platform: &'static str,
    pub devices: Vec<AudioDevice>,
    pub apps: Vec<AudioApp>,
}

#[tauri::command]
pub async fn system_audio_snapshot() -> Result<SystemAudio, String> {
    // COM calls block briefly; keep them off the async runtime's threads.
    tauri::async_runtime::spawn_blocking(snapshot)
        .await
        .map_err(|e| e.to_string())?
}

/// Longest a level preview keeps a microphone open, in case the UI never stops it.
#[cfg(target_os = "windows")]
const LISTEN_LIMIT: std::time::Duration = std::time::Duration::from_secs(30);

/// Opens a recording device briefly so Windows reports its level in `system_audio_snapshot`.
/// Windows only measures a microphone while some program records from it.
#[tauri::command]
pub async fn device_listen_start(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || listen_start(id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn device_listen_stop() {
    listen_stop();
}

static LISTENING: std::sync::Mutex<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>> = std::sync::Mutex::new(None);

fn listen_stop() {
    if let Some(stop) = LISTENING.lock().unwrap().take() {
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(not(target_os = "windows"))]
fn listen_start(_id: String) -> Result<(), String> {
    Err("這個平台還不支援試聽音量".into())
}

#[cfg(target_os = "windows")]
fn listen_start(id: String) -> Result<(), String> {
    listen_stop();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (ready, opened) = std::sync::mpsc::channel();
    let thread_stop = stop.clone();
    // The capture stream lives on its own thread, which drains it until told to stop.
    std::thread::spawn(move || win::listen(&id, &thread_stop, ready));
    opened
        .recv()
        .map_err(|_| "試聽失敗".to_string())?
        .map_err(|e| format!("無法開啟這個裝置：{e}"))?;
    *LISTENING.lock().unwrap() = Some(stop);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn snapshot() -> Result<SystemAudio, String> {
    Ok(SystemAudio {
        supported: false,
        platform: std::env::consts::OS,
        devices: vec![],
        apps: vec![],
    })
}

#[cfg(target_os = "windows")]
fn snapshot() -> Result<SystemAudio, String> {
    win::snapshot().map_err(|e| format!("讀取系統聲音失敗：{e}"))
}

#[cfg(target_os = "windows")]
mod win {
    use std::collections::HashMap;

    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Foundation::{HWND, LPARAM, S_OK};
    use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
    use windows::Win32::Media::Audio::{
        AudioSessionStateActive, DEVICE_STATE_ACTIVE, IAudioSessionControl2, IAudioSessionManager2,
        IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, eCapture, eCommunications, eConsole, eRender,
    };
    use windows::Win32::System::Com::{
        CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
        STGM_READ,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
    };
    use windows::core::{BOOL, Interface, PWSTR, Result};

    use super::{AudioApp, AudioDevice, SystemAudio};

    unsafe fn device_id(device: &IMMDevice) -> Result<String> {
        unsafe {
            let id: PWSTR = device.GetId()?;
            let text = id.to_string().unwrap_or_default();
            CoTaskMemFree(Some(id.0 as _));
            Ok(text)
        }
    }

    unsafe fn device_name(device: &IMMDevice) -> String {
        unsafe {
            device
                .OpenPropertyStore(STGM_READ)
                .and_then(|store| store.GetValue(&PKEY_Device_FriendlyName))
                .map(|value| value.to_string())
                .unwrap_or_default()
        }
    }

    unsafe fn peak<T: Interface>(object: &T) -> f32 {
        unsafe {
            object
                .cast::<IAudioMeterInformation>()
                .and_then(|m| m.GetPeakValue())
                .unwrap_or(0.0)
        }
    }

    /// The first visible, titled top-level window of each process: what OBS's app capture matches on.
    fn main_windows() -> HashMap<u32, (String, String)> {
        unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
            unsafe {
                let found = &mut *(lparam.0 as *mut HashMap<u32, (String, String)>);
                if IsWindowVisible(hwnd).as_bool() {
                    let mut pid = 0u32;
                    GetWindowThreadProcessId(hwnd, Some(&mut pid));
                    let mut title = [0u16; 512];
                    let len = GetWindowTextW(hwnd, &mut title);
                    if len > 0 && !found.contains_key(&pid) {
                        let mut class = [0u16; 256];
                        let class_len = GetClassNameW(hwnd, &mut class);
                        found.insert(
                            pid,
                            (
                                String::from_utf16_lossy(&title[..len as usize]),
                                String::from_utf16_lossy(&class[..class_len.max(0) as usize]),
                            ),
                        );
                    }
                }
                BOOL(1)
            }
        }
        let mut found: HashMap<u32, (String, String)> = HashMap::new();
        unsafe {
            let _ = EnumWindows(Some(collect), LPARAM(&mut found as *mut _ as isize));
        }
        found
    }

    pub fn snapshot() -> Result<SystemAudio> {
        unsafe {
            // Already initialised on this thread (possibly in another mode) is fine.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;

            let mut processes = System::new();
            processes.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing(),
            );
            let windows = main_windows();

            let mut devices = Vec::new();
            let mut apps: Vec<AudioApp> = Vec::new();
            // OBS resolves "default" with these same roles (win-wasapi.cpp), so "預設" matches what OBS records.
            for (flow, role, label) in [(eRender, eConsole, "render"), (eCapture, eCommunications, "capture")] {
                let default_id = enumerator
                    .GetDefaultAudioEndpoint(flow, role)
                    .and_then(|d| device_id(&d))
                    .unwrap_or_default();
                let collection = enumerator.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE)?;
                for i in 0..collection.GetCount()? {
                    let device = collection.Item(i)?;
                    let id = device_id(&device)?;
                    let meter: Option<IAudioMeterInformation> =
                        device.Activate(CLSCTX_ALL, None).ok();
                    devices.push(AudioDevice {
                        is_default: id == default_id,
                        name: device_name(&device),
                        flow: label,
                        peak: meter
                            .map(|m| m.GetPeakValue().unwrap_or(0.0))
                            .unwrap_or(0.0),
                        id: id.clone(),
                    });
                    if flow == eRender {
                        collect_sessions(&device, &id, &processes, &windows, &mut apps);
                    }
                }
            }
            Ok(SystemAudio {
                supported: true,
                platform: "windows",
                devices,
                apps,
            })
        }
    }

    /// Records from `id` and throws the audio away until `stop`, so its level meter runs.
    pub fn listen(
        id: &str,
        stop: &std::sync::atomic::AtomicBool,
        ready: std::sync::mpsc::Sender<std::result::Result<(), String>>,
    ) {
        use std::sync::atomic::Ordering;
        use windows::Win32::Media::Audio::{AUDCLNT_SHAREMODE_SHARED, IAudioCaptureClient, IAudioClient};
        use windows::core::HSTRING;

        const ONE_SECOND_HNS: i64 = 10_000_000;
        let open = || -> Result<(IAudioClient, IAudioCaptureClient)> {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
                let device = enumerator.GetDevice(&HSTRING::from(id))?;
                let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
                let format = client.GetMixFormat()?;
                let init = client.Initialize(AUDCLNT_SHAREMODE_SHARED, 0, ONE_SECOND_HNS, 0, format, None);
                CoTaskMemFree(Some(format as _));
                init?;
                let capture: IAudioCaptureClient = client.GetService()?;
                client.Start()?;
                Ok((client, capture))
            }
        };
        let (client, capture) = match open() {
            Ok(pair) => {
                let _ = ready.send(Ok(()));
                pair
            }
            Err(e) => {
                let _ = ready.send(Err(e.message()));
                return;
            }
        };

        let started = std::time::Instant::now();
        while !stop.load(Ordering::SeqCst) && started.elapsed() < super::LISTEN_LIMIT {
            unsafe {
                while capture.GetNextPacketSize().unwrap_or(0) > 0 {
                    let mut data = std::ptr::null_mut();
                    let mut frames = 0u32;
                    let mut flags = 0u32;
                    if capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None).is_err() {
                        break;
                    }
                    let _ = capture.ReleaseBuffer(frames);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        unsafe {
            let _ = client.Stop();
        }
    }

    unsafe fn collect_sessions(
        device: &IMMDevice,
        device_id: &str,
        processes: &System,
        windows: &HashMap<u32, (String, String)>,
        apps: &mut Vec<AudioApp>,
    ) {
        unsafe {
            let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
                return;
            };
            let Ok(sessions) = manager.GetSessionEnumerator() else {
                return;
            };
            for i in 0..sessions.GetCount().unwrap_or(0) {
                let Ok(control) = sessions.GetSession(i) else {
                    continue;
                };
                let Ok(control) = control.cast::<IAudioSessionControl2>() else {
                    continue;
                };
                // S_OK means "system sounds" (notification dings), which is not an app.
                // A bare HRESULT: normal apps return S_FALSE, which also counts as "ok", so compare exactly.
                if control.IsSystemSoundsSession() == S_OK {
                    continue;
                }
                if control
                    .GetState()
                    .map_or(true, |s| s != AudioSessionStateActive)
                {
                    continue;
                }
                let Ok(pid) = control.GetProcessId() else {
                    continue;
                };
                let Some(process) = processes.process(sysinfo::Pid::from_u32(pid)) else {
                    continue;
                };
                let level = peak(&control);
                // One app can hold several sessions on a device; keep the loudest.
                if let Some(existing) = apps
                    .iter_mut()
                    .find(|a| a.pid == pid && a.device_id == device_id)
                {
                    existing.peak = existing.peak.max(level);
                    continue;
                }
                let window = windows.get(&pid);
                apps.push(AudioApp {
                    pid,
                    exe: process.name().to_string_lossy().into_owned(),
                    window_title: window.map(|w| w.0.clone()),
                    window_class: window.map(|w| w.1.clone()),
                    device_id: device_id.to_string(),
                    peak: level,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    /// Prints what this machine reports; run with `cargo test print_snapshot -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn print_snapshot() {
        let s = super::snapshot().expect("snapshot");
        println!("supported={} platform={}", s.supported, s.platform);
        for d in &s.devices {
            println!("device {:7} default={:5} peak={:.4} {} [{}]", d.flow, d.is_default, d.peak, d.name, d.id);
        }
        for a in &s.apps {
            println!("app {} pid={} peak={:.4} title={:?} class={:?}", a.exe, a.pid, a.peak, a.window_title, a.window_class);
        }
    }

    /// Opens every recording device in turn and prints the level Windows reports while it is open.
    #[test]
    #[ignore]
    fn print_listen_levels() {
        let devices: Vec<_> = super::snapshot().unwrap().devices.into_iter().filter(|d| d.flow == "capture").collect();
        for d in devices {
            match super::listen_start(d.id.clone()) {
                Ok(()) => {
                    let mut peak = 0f32;
                    for _ in 0..10 {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        let now = super::snapshot().unwrap();
                        if let Some(x) = now.devices.iter().find(|x| x.id == d.id) {
                            peak = peak.max(x.peak);
                        }
                    }
                    super::listen_stop();
                    println!("listen {:.4} {}", peak, d.name);
                }
                Err(e) => println!("listen ERR {} {}", d.name, e),
            }
        }
    }
}
