//! Reads the local OBS's obs-websocket settings so the app can connect without asking.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct RawConfig {
    server_enabled: bool,
    server_port: u16,
    auth_required: bool,
    #[serde(default)]
    server_password: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsocketConfig {
    pub enabled: bool,
    pub port: u16,
    /// `None` when OBS does not require a password.
    pub password: Option<String>,
}

fn config_path() -> Option<PathBuf> {
    // Same folder on every platform once the OS config dir is known:
    // %APPDATA%, ~/Library/Application Support, or ~/.config.
    let base = dirs::config_dir()?;
    Some(base.join("obs-studio").join("plugin_config").join("obs-websocket").join("config.json"))
}

/// Returns `Ok(None)` when OBS has never been run on this machine (no config file).
#[tauri::command]
pub fn read_obs_websocket_config() -> Result<Option<WebsocketConfig>, String> {
    let Some(path) = config_path() else { return Ok(None) };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("無法讀取 {}：{e}", path.display())),
    };
    let raw: RawConfig = serde_json::from_str(&text).map_err(|e| format!("OBS WebSocket 設定格式不符：{e}"))?;
    Ok(Some(WebsocketConfig {
        enabled: raw.server_enabled,
        port: raw.server_port,
        password: raw.auth_required.then_some(raw.server_password),
    }))
}
