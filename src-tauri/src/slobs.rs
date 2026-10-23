//! Transport for Streamlabs Desktop's local API: newline-delimited JSON-RPC over its named
//! pipe (Windows `\\.\pipe\slobs`) or Unix socket (macOS). Streamlabs authorizes these local
//! connections by itself, so no token is needed. The UI does the JSON-RPC; this module only
//! moves lines: each received line is emitted as `slobs-message`, and `slobs-closed` fires
//! when the connection ends. Both carry the connection number `slobs_connect` returned, so the
//! UI can ignore stragglers from a connection it already replaced.

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;

use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};

use crate::i18n::trf;

#[derive(Default)]
pub struct Slobs {
    outgoing: Mutex<Option<UnboundedSender<String>>>,
    next_connection: AtomicU64,
}

#[derive(Clone, Serialize)]
struct Message {
    connection: u64,
    line: String,
}

#[cfg(target_os = "windows")]
pub const PIPE: &str = r"\\.\pipe\slobs";

/// Where Streamlabs Desktop listens on macOS.
#[cfg(not(target_os = "windows"))]
pub fn socket_path() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join("slobs-client").join("slobs.sock"))
}

#[cfg(target_os = "windows")]
pub const PROCESS_NAMES: [&str; 2] = ["Streamlabs OBS.exe", "Streamlabs Desktop.exe"];
#[cfg(not(target_os = "windows"))]
pub const PROCESS_NAMES: [&str; 2] = ["Streamlabs OBS", "Streamlabs Desktop"];

/// Whether Streamlabs Desktop's local API is accepting connections right now.
pub fn available() -> bool {
    #[cfg(target_os = "windows")]
    {
        std::path::Path::new(PIPE).exists()
    }
    #[cfg(not(target_os = "windows"))]
    {
        socket_path().is_some_and(|p| p.exists())
    }
}

#[tauri::command]
pub async fn slobs_connect(app: AppHandle, state: State<'_, Slobs>) -> Result<u64, String> {
    slobs_disconnect(state.clone());
    let fail = |e: std::io::Error| trf("無法連到 Streamlabs：{e}", &[("e", &e)]);

    #[cfg(target_os = "windows")]
    let stream = tokio::net::windows::named_pipe::ClientOptions::new().open(PIPE).map_err(fail)?;
    #[cfg(not(target_os = "windows"))]
    let stream = {
        let path = socket_path().ok_or_else(|| fail(std::io::ErrorKind::NotFound.into()))?;
        tokio::net::UnixStream::connect(path).await.map_err(fail)?
    };

    let (tx, rx) = unbounded_channel();
    *state.outgoing.lock().unwrap() = Some(tx);
    let connection = state.next_connection.fetch_add(1, Ordering::SeqCst) + 1;
    run(app, stream, rx, connection);
    Ok(connection)
}

/// Sends one JSON-RPC request (a single line of JSON).
#[tauri::command]
pub fn slobs_send(state: State<'_, Slobs>, line: String) -> Result<(), String> {
    match state.outgoing.lock().unwrap().as_ref() {
        Some(tx) if tx.send(line).is_ok() => Ok(()),
        _ => Err("not connected".into()),
    }
}

#[tauri::command]
pub fn slobs_disconnect(state: State<'_, Slobs>) {
    // Dropping the sender ends the writer task, which closes the connection.
    state.outgoing.lock().unwrap().take();
}

fn run<S>(app: AppHandle, stream: S, mut outgoing: tokio::sync::mpsc::UnboundedReceiver<String>, connection: u64)
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let (reader, mut writer) = tokio::io::split(stream);

    tauri::async_runtime::spawn(async move {
        while let Some(line) = outgoing.recv().await {
            if writer.write_all(format!("{line}\n").as_bytes()).await.is_err() {
                break;
            }
        }
        let _ = writer.shutdown().await;
    });

    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app.emit("slobs-message", Message { connection, line });
        }
        let _ = app.emit("slobs-closed", connection);
    });
}

/// Starts Streamlabs Desktop, for the connection guide's button.
#[tauri::command]
pub fn launch_streamlabs() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

        let exe = windows_streamlabs_exe().unwrap_or_else(|| PathBuf::from(r"C:\Program Files\Streamlabs OBS\Streamlabs OBS.exe"));
        std::process::Command::new(&exe)
            .current_dir(exe.parent().unwrap_or(&exe))
            .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
            .spawn()
            .map(|_| ())
            .map_err(|e| trf("無法開啟直播軟體：{e}", &[("e", &e)]))
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", "Streamlabs Desktop"])
            .spawn()
            .map(|_| ())
            .map_err(|e| trf("無法開啟直播軟體：{e}", &[("e", &e)]))
    }
    #[cfg(target_os = "linux")]
    {
        Err(crate::i18n::tr("這個平台不能從這裡開啟直播軟體。"))
    }
}

/// The executable named by Streamlabs' uninstall entry (its DisplayIcon is "…\Streamlabs OBS.exe,0").
#[cfg(target_os = "windows")]
fn windows_streamlabs_exe() -> Option<PathBuf> {
    let output = std::process::Command::new("reg")
        .args(["query", r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", "/s", "/v", "DisplayIcon"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().find(|l| l.contains("REG_SZ") && l.contains("Streamlabs"))?;
    let value = line.split("REG_SZ").nth(1)?.trim();
    let path = PathBuf::from(value.rsplit_once(',').map_or(value, |(path, _)| path));
    path.exists().then_some(path)
}
