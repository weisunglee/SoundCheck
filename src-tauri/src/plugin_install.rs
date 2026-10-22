//! Installs the bundled obs-audio-kit OBS plugin and reports what is installed.
//!
//! OBS must be closed to install: Windows locks a loaded DLL, and OBS only
//! loads plugins at startup. The app never closes OBS itself; the user does,
//! so they can finish a stream or save their work first.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

pub const BUNDLED_VERSION: &str = env!("OBS_AUDIO_KIT_PLUGIN_VERSION");

/// Where the bundled plugin lives inside the app's resources (see tauri.<platform>.conf.json).
#[cfg(target_os = "windows")]
const RESOURCE: &str = "obs-plugin/obs-audio-kit.dll";
#[cfg(target_os = "macos")]
const RESOURCE: &str = "obs-plugin/obs-audio-kit.plugin";
#[cfg(target_os = "linux")]
const RESOURCE: &str = "obs-plugin/obs-audio-kit.so";

#[cfg(target_os = "windows")]
const OBS_PROCESS: &str = "obs64.exe";
#[cfg(target_os = "macos")]
const OBS_PROCESS: &str = "OBS";
#[cfg(target_os = "linux")]
const OBS_PROCESS: &str = "obs";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStatus {
    /// `None` when this build of the app has no plugin bundled (e.g. a dev build).
    bundled_version: Option<String>,
    installed: bool,
    /// Read from the installed file; `None` if not installed or it carries no version.
    installed_version: Option<String>,
    install_path: String,
    obs_running: bool,
    /// From OBS 32's plugin manager; `None` when OBS has no record of the plugin yet.
    enabled_in_plugin_manager: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallError {
    /// "obsRunning", "permissionDenied", "notBundled", "cancelled" or "failed".
    kind: &'static str,
    message: String,
}

impl InstallError {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
}

/// Appends one timestamped line to `install.log` in the app's log folder
/// (Windows: %LOCALAPPDATA%\io.github.weisunglee.obsaudiokit\logs).
fn log(app: &AppHandle, message: impl AsRef<str>) {
    let Ok(dir) = app.path().app_log_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("install.log")) {
        let _ = writeln!(file, "{} {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"), message.as_ref());
    }
}

/// Lets the install dialog record what the user saw and clicked.
#[tauri::command]
pub fn log_install_event(app: AppHandle, message: String) {
    log(&app, format!("[ui] {message}"));
}

fn obs_config_dir() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join("obs-studio"))
}

/// The installed plugin file (Windows/Linux) or bundle (macOS).
fn install_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let program_data = std::env::var_os("ProgramData")?;
        Some(PathBuf::from(program_data).join(r"obs-studio\plugins\obs-audio-kit\bin\64bit\obs-audio-kit.dll"))
    }
    #[cfg(target_os = "macos")]
    {
        Some(obs_config_dir()?.join("plugins/obs-audio-kit.plugin"))
    }
    #[cfg(target_os = "linux")]
    {
        Some(obs_config_dir()?.join("plugins/obs-audio-kit/bin/64bit/obs-audio-kit.so"))
    }
}

fn bundled_path(app: &AppHandle) -> Option<PathBuf> {
    let path = app.path().resolve(RESOURCE, BaseDirectory::Resource).ok()?;
    path.exists().then_some(path)
}

/// The plugin version stored in the file itself (Windows version resource, macOS Info.plist).
fn file_version(path: &Path) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        use pelite::pe64::{Pe, PeFile};
        let bytes = std::fs::read(path).ok()?;
        let file = PeFile::from_bytes(&bytes).ok()?;
        let info = file.resources().ok()?.version_info().ok()?;
        let v = info.fixed()?.dwFileVersion;
        Some(format!("{}.{}.{}", v.Major, v.Minor, v.Patch))
    }
    #[cfg(target_os = "macos")]
    {
        let plist = std::fs::read_to_string(path.join("Contents/Info.plist")).ok()?;
        let after = plist.split("<key>CFBundleShortVersionString</key>").nth(1)?;
        let value = after.split("<string>").nth(1)?.split("</string>").next()?;
        Some(value.trim().to_string())
    }
    #[cfg(target_os = "linux")]
    {
        let _ = path;
        None
    }
}

fn obs_running() -> bool {
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    system.processes_by_exact_name(OBS_PROCESS.as_ref()).next().is_some()
}

/// OBS 32+ keeps `plugin_manager/modules.json`: `[{ "module_name": …, "enabled": … }, …]`.
fn enabled_in_plugin_manager() -> Option<bool> {
    let text = std::fs::read_to_string(obs_config_dir()?.join("plugin_manager/modules.json")).ok()?;
    let modules: Vec<serde_json::Value> = serde_json::from_str(&text).ok()?;
    modules
        .iter()
        .find(|m| m["module_name"] == "obs-audio-kit")
        .and_then(|m| m["enabled"].as_bool())
}

#[tauri::command]
pub fn plugin_status(app: AppHandle) -> PluginStatus {
    let path = install_path();
    let installed = path.as_deref().is_some_and(Path::exists);
    PluginStatus {
        bundled_version: bundled_path(&app).map(|_| BUNDLED_VERSION.to_string()),
        installed,
        installed_version: if installed { path.as_deref().and_then(file_version) } else { None },
        install_path: path.map(|p| p.display().to_string()).unwrap_or_default(),
        obs_running: obs_running(),
        enabled_in_plugin_manager: enabled_in_plugin_manager(),
    }
}

fn copy_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(from, to).map(|_| ())
    }
}

fn check_installed(app: &AppHandle, target: &Path) -> Result<(), InstallError> {
    let found = file_version(target);
    log(app, format!("check: {} exists={} version={found:?} expected={BUNDLED_VERSION}", target.display(), target.exists()));
    match found {
        Some(v) if v != BUNDLED_VERSION => Err(InstallError::new(
            "failed",
            format!("安裝後的外掛版本是 {v}，不是預期的 {BUNDLED_VERSION}。"),
        )),
        _ => Ok(()),
    }
}

fn prepare(app: &AppHandle) -> Result<(PathBuf, PathBuf), InstallError> {
    let running = obs_running();
    let source = bundled_path(app);
    let target = install_path();
    log(app, format!("prepare: obs_running={running} source={source:?} target={target:?}"));
    if running {
        return Err(InstallError::new("obsRunning", "OBS 還開著。請先關閉 OBS 再安裝。"));
    }
    let source = source.ok_or_else(|| InstallError::new("notBundled", "這個版本的 App 沒有附外掛。"))?;
    let target = target.ok_or_else(|| InstallError::new("failed", "找不到 OBS 的外掛資料夾。"))?;
    Ok((source, target))
}

/// Runs an install step and records how it ended.
fn logged(app: &AppHandle, step: &str, run: impl FnOnce() -> Result<(), InstallError>) -> Result<(), InstallError> {
    log(app, format!("{step}: start (app {}, bundled plugin {BUNDLED_VERSION})", app.package_info().version));
    let result = run();
    match &result {
        Ok(()) => log(app, format!("{step}: ok")),
        Err(e) => log(app, format!("{step}: error kind={} message={}", e.kind, e.message)),
    }
    result
}

/// Installs with the user's normal permissions.
#[tauri::command]
pub fn install_plugin(app: AppHandle) -> Result<(), InstallError> {
    logged(&app, "install", || install_normal(&app))
}

fn install_normal(app: &AppHandle) -> Result<(), InstallError> {
    let (source, target) = prepare(app)?;
    let result = (|| {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if source.is_dir() && target.exists() {
            std::fs::remove_dir_all(&target)?;
        }
        copy_recursive(&source, &target)
    })();

    match result {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            log(app, format!("copy: {e}"));
            return Err(InstallError::new(
                "permissionDenied",
                "沒有權限寫入外掛資料夾。這通常是因為之前用系統管理員權限安裝過外掛。",
            ));
        }
        Err(e) => return Err(InstallError::new("failed", format!("複製外掛失敗：{e}"))),
    }
    log(app, "copy: done");

    #[cfg(target_os = "macos")]
    {
        // Files copied by the app can inherit the quarantine flag from a downloaded app bundle.
        let _ = Command::new("xattr").args(["-dr", "com.apple.quarantine"]).arg(&target).status();
    }

    check_installed(app, &target)
}

/// Windows only: copies the plugin through an elevated cmd script, which shows a UAC prompt.
/// Used when an earlier elevated install left the folder writable only by administrators.
#[tauri::command]
pub fn install_plugin_elevated(app: AppHandle) -> Result<(), InstallError> {
    logged(&app, "install-elevated", || install_elevated(&app))
}

fn install_elevated(app: &AppHandle) -> Result<(), InstallError> {
    #[cfg(target_os = "windows")]
    {
        let (source, target) = prepare(app)?;
        let dir = target.parent().ok_or_else(|| InstallError::new("failed", "外掛路徑不正確"))?;
        let temp = std::env::temp_dir();
        let script = temp.join("obs-audio-kit-install.cmd");
        // The elevated script reports copy's own output and exit code here, since its
        // console is hidden and Start-Process only tells us whether it was allowed to run.
        let result_file = temp.join("obs-audio-kit-install-result.txt");
        let _ = std::fs::remove_file(&result_file);
        let body = format!(
            "@echo off\r\nif not exist \"{dir}\" mkdir \"{dir}\" > \"{res}\" 2>&1\r\ncopy /Y \"{src}\" \"{dst}\" >> \"{res}\" 2>&1\r\necho copy-exit=%errorlevel% >> \"{res}\"\r\n",
            dir = dir.display(),
            src = source.display(),
            dst = target.display(),
            res = result_file.display(),
        );
        log(app, format!("elevated: script {}:\n{body}", script.display()));
        std::fs::write(&script, &body).map_err(|e| InstallError::new("failed", e.to_string()))?;

        let ps_path = script.display().to_string().replace('\'', "''");
        let output = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!("Start-Process -FilePath '{ps_path}' -Verb RunAs -Wait -WindowStyle Hidden"),
            ])
            .output()
            .map_err(|e| InstallError::new("failed", e.to_string()))?;
        log(
            app,
            format!(
                "elevated: powershell exit={:?} stdout={:?} stderr={:?}",
                output.status.code(),
                String::from_utf8_lossy(&output.stdout).trim(),
                String::from_utf8_lossy(&output.stderr).trim(),
            ),
        );
        match std::fs::read(&result_file) {
            // cmd writes in the console code page; lossy UTF-8 keeps the ASCII parts readable.
            Ok(bytes) => log(app, format!("elevated: script output: {:?}", String::from_utf8_lossy(&bytes).trim())),
            Err(e) => log(app, format!("elevated: no script output ({e}); the script may not have run")),
        }
        let _ = std::fs::remove_file(&script);
        let _ = std::fs::remove_file(&result_file);

        // PowerShell fails Start-Process when the user answers "No" in the UAC prompt.
        if !output.status.success() {
            return Err(InstallError::new("cancelled", "已取消系統管理員權限的安裝。"));
        }
        if !target.exists() {
            return Err(InstallError::new("failed", "安裝後找不到外掛檔案。"));
        }
        check_installed(app, &target)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err(InstallError::new("failed", "只有 Windows 需要系統管理員權限安裝。"))
    }
}

/// Starts OBS the way its own shortcut does.
#[tauri::command]
pub fn launch_obs(app: AppHandle) -> Result<(), String> {
    let result = spawn_obs();
    log(&app, format!("launch-obs: {result:?}"));
    result
}

fn spawn_obs() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

        let install_dir = windows_obs_install_dir().unwrap_or_else(|| PathBuf::from(r"C:\Program Files\obs-studio"));
        let bin = install_dir.join(r"bin\64bit");
        // OBS looks up its data relative to the working directory, so start it from its bin folder.
        Command::new(bin.join("obs64.exe"))
            .current_dir(&bin)
            .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("無法開啟 OBS：{e}"))
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").args(["-a", "OBS"]).spawn().map(|_| ()).map_err(|e| format!("無法開啟 OBS：{e}"))
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("obs").spawn().map(|_| ()).map_err(|e| format!("無法開啟 OBS：{e}"))
    }
}

/// The OBS installer records its folder as the default value of `HKLM\SOFTWARE\OBS Studio`.
#[cfg(target_os = "windows")]
fn windows_obs_install_dir() -> Option<PathBuf> {
    let output = Command::new("reg").args(["query", r"HKLM\SOFTWARE\OBS Studio", "/ve"]).output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().find(|l| l.contains("REG_SZ"))?;
    let value = line.split("REG_SZ").nth(1)?.trim();
    (!value.is_empty()).then(|| PathBuf::from(value))
}
