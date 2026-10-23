//! The SoundCheck plugin's Streamlabs build (soundcheck-streamlabs): installing it into
//! Streamlabs' user plugin folder, and talking to it over its control port.
//!
//! Streamlabs loads every module in %APPDATA%\slobs-plugins\obs-plugins\64bit when it starts
//! (the frontend can also load one right away through ObsUserPluginsService.initializeModule).
//! While Streamlabs runs, the loaded DLL is locked, so updating needs Streamlabs closed.
//! The plugin writes its control port and a token to control.json in its data folder; see
//! obs-plugin/src/plugin-streamlabs.cpp for the protocol.

use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

use crate::i18n::{tr, trf};
use crate::plugin_install::{file_version, same_version, BUNDLED_VERSION};
use crate::presence;

/// The module's file name; Streamlabs names the module (and its data folder) after it.
const MODULE: &str = "soundcheck-streamlabs";
/// Where the bundled plugin lives inside the app's resources (see tauri.windows.conf.json).
const RESOURCE: &str = "obs-plugin/soundcheck-streamlabs.dll";

const CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
const ANSWER_TIMEOUT: Duration = Duration::from_secs(5);

fn plugins_base() -> Option<PathBuf> {
    // Streamlabs uses Electron's appData folder: %APPDATA% on Windows.
    Some(dirs::config_dir()?.join("slobs-plugins"))
}

fn install_path() -> Option<PathBuf> {
    Some(plugins_base()?.join("obs-plugins").join("64bit").join(format!("{MODULE}.dll")))
}

fn control_path() -> Option<PathBuf> {
    Some(data_dir()?.join("control.json"))
}

fn bundled_path(app: &AppHandle) -> Option<PathBuf> {
    let path = app.path().resolve(RESOURCE, BaseDirectory::Resource).ok()?;
    path.exists().then_some(path)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamlabsPluginStatus {
    /// `None` when this build of the app has no Streamlabs plugin bundled.
    bundled_version: Option<String>,
    installed: bool,
    installed_version: Option<String>,
    streamlabs_running: bool,
}

#[tauri::command]
pub fn streamlabs_plugin_status(app: AppHandle) -> StreamlabsPluginStatus {
    let path = install_path();
    let installed = path.as_deref().is_some_and(Path::exists);
    StreamlabsPluginStatus {
        // The plugin is built for Windows only.
        bundled_version: (cfg!(target_os = "windows") && bundled_path(&app).is_some()).then(|| BUNDLED_VERSION.to_string()),
        installed,
        installed_version: if installed { path.as_deref().and_then(file_version) } else { None },
        streamlabs_running: presence::scan().streamlabs,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallError {
    /// "streamlabsRunning" (Streamlabs has the plugin loaded, so its file is locked), "notBundled" or "failed".
    kind: &'static str,
    message: String,
}

impl InstallError {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
}

/// Copies the bundled plugin into Streamlabs' plugin folder. Works while Streamlabs runs as long
/// as it hasn't loaded an older copy; the frontend then loads it with initializeModule.
#[tauri::command]
pub fn install_streamlabs_plugin(app: AppHandle) -> Result<(), InstallError> {
    let source = bundled_path(&app).ok_or_else(|| InstallError::new("notBundled", tr("這個版本的 App 沒有附外掛。")))?;
    let target = install_path().ok_or_else(|| InstallError::new("failed", tr("找不到直播軟體的外掛資料夾。")))?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| InstallError::new("failed", trf("複製外掛失敗：{e}", &[("e", &e)])))?;
    }
    if let Err(e) = std::fs::copy(&source, &target) {
        // Windows: ERROR_SHARING_VIOLATION (32) or ERROR_USER_MAPPED_FILE (1224) while it is loaded.
        let locked = matches!(e.raw_os_error(), Some(32) | Some(1224)) || e.kind() == std::io::ErrorKind::PermissionDenied;
        return Err(if locked {
            InstallError::new("streamlabsRunning", tr("直播軟體正在使用舊版外掛。請先關閉直播軟體再安裝。"))
        } else {
            InstallError::new("failed", trf("複製外掛失敗：{e}", &[("e", &e)]))
        });
    }
    match file_version(&target) {
        Some(v) if !same_version(&v, BUNDLED_VERSION) => Err(InstallError::new(
            "failed",
            trf("安裝後的外掛版本是 {found}，不是預期的 {expected}。", &[("found", &v), ("expected", &BUNDLED_VERSION)]),
        )),
        _ => Ok(()),
    }
}

fn data_dir() -> Option<PathBuf> {
    Some(plugins_base()?.join("data").join("obs-plugins").join(MODULE))
}

/// Removes the plugin and its data folder. Fails with "streamlabsRunning" while Streamlabs has
/// it loaded (the file is locked until Streamlabs closes).
#[tauri::command]
pub fn uninstall_streamlabs_plugin() -> Result<(), InstallError> {
    if let Some(dll) = install_path().filter(|p| p.exists()) {
        if let Err(e) = std::fs::remove_file(&dll) {
            let locked = matches!(e.raw_os_error(), Some(5) | Some(32) | Some(1224)) || e.kind() == std::io::ErrorKind::PermissionDenied;
            return Err(if locked {
                InstallError::new("streamlabsRunning", tr("直播軟體正在使用外掛。請先關閉直播軟體再移除。"))
            } else {
                InstallError::new("failed", trf("移除外掛失敗：{e}", &[("e", &e)]))
            });
        }
    }
    // Drop the connection to a plugin that is going away, and its control file.
    *CONNECTION.lock().unwrap_or_else(|e| e.into_inner()) = None;
    if let Some(dir) = data_dir().filter(|p| p.exists()) {
        std::fs::remove_dir_all(&dir).map_err(|e| InstallError::new("failed", trf("移除外掛失敗：{e}", &[("e", &e)])))?;
    }
    Ok(())
}

#[derive(Deserialize)]
struct Control {
    port: u16,
    token: String,
}

/// One connection to the plugin, kept open: the level meters ask ten times a second.
struct Connection {
    token: String,
    reader: BufReader<TcpStream>,
}

static CONNECTION: Mutex<Option<Connection>> = Mutex::new(None);

const NOT_LOADED: &str = "notLoaded";

/// Sends one request to the loaded plugin and returns its answer. Fails with "notLoaded" when
/// no plugin is listening (not installed, not loaded yet, or a control file from an earlier run).
#[tauri::command]
pub async fn streamlabs_plugin_request(request_type: String, request_data: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || request(&request_type, request_data))
        .await
        .map_err(|e| e.to_string())?
}

fn connect() -> Result<Connection, String> {
    let path = control_path().ok_or(NOT_LOADED)?;
    let control: Control = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .ok_or(NOT_LOADED)?;
    let socket =
        TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], control.port)), CONNECT_TIMEOUT).map_err(|_| NOT_LOADED)?;
    socket.set_read_timeout(Some(ANSWER_TIMEOUT)).map_err(|e| e.to_string())?;
    Ok(Connection { token: control.token, reader: BufReader::new(socket) })
}

enum Failure {
    /// The plugin had already closed the connection (idle, or Streamlabs restarted); the
    /// request never reached it, so it is safe to send again on a new connection.
    Closed,
    Other(String),
}

fn exchange(connection: &mut Connection, request_type: &str, request_data: &Value) -> Result<Value, Failure> {
    let line = serde_json::json!({ "token": connection.token, "requestType": request_type, "requestData": request_data });
    connection.reader.get_mut().write_all(format!("{line}\n").as_bytes()).map_err(|_| Failure::Closed)?;
    let mut answer = String::new();
    match connection.reader.read_line(&mut answer) {
        Ok(0) => Err(Failure::Closed),
        Ok(_) => serde_json::from_str(&answer).map_err(|_| Failure::Other(NOT_LOADED.to_string())),
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset || e.kind() == std::io::ErrorKind::ConnectionAborted => {
            Err(Failure::Closed)
        }
        Err(e) => Err(Failure::Other(e.to_string())),
    }
}

fn request(request_type: &str, request_data: Value) -> Result<Value, String> {
    let mut current = CONNECTION.lock().unwrap_or_else(|e| e.into_inner());
    for attempt in 0..2 {
        if current.is_none() {
            *current = Some(connect()?);
        }
        match exchange(current.as_mut().unwrap(), request_type, &request_data) {
            Ok(answer) => return Ok(answer),
            Err(Failure::Closed) if attempt == 0 => *current = None,
            Err(Failure::Closed) => {
                *current = None;
                return Err(NOT_LOADED.to_string());
            }
            Err(Failure::Other(e)) => {
                *current = None;
                return Err(e);
            }
        }
    }
    unreachable!()
}
