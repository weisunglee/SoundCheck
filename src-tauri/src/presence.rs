//! Watches for the streaming software (OBS, Streamlabs) starting and stopping from a native thread.
//!
//! The webview's own retry timer is not enough: Windows WebView2 throttles and
//! eventually suspends timers in a minimized or hidden window, so a user who
//! opens OBS while this app is in the background could wait a minute or more.

use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter};

use crate::obs_config;
use crate::plugin_install::OBS_PROCESS;
use crate::slobs;

const POLL: Duration = Duration::from_secs(1);
const PROBE_TIMEOUT: Duration = Duration::from_millis(300);

#[derive(Clone, Copy, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Presence {
    running: bool,
    /// Running and accepting connections (OBS: WebSocket port open; Streamlabs: API pipe open).
    ready: bool,
}

#[derive(Clone, Copy, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct SoftwarePresence {
    obs: Presence,
    streamlabs: Presence,
}

/// Which streaming software has a process right now.
pub struct Running {
    pub obs: bool,
    pub streamlabs: bool,
}

/// Lists the processes once and looks for both programs in it.
pub fn scan() -> Running {
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let has = |name: &str| system.processes_by_exact_name(name.as_ref()).next().is_some();
    Running { obs: has(OBS_PROCESS), streamlabs: slobs::PROCESS_NAMES.iter().any(|name| has(name)) }
}

static OBS_SEEN_RUNNING: AtomicBool = AtomicBool::new(false);

/// Whether OBS was running at the watcher's last scan (at most about a second ago).
pub fn obs_seen_running() -> bool {
    OBS_SEEN_RUNNING.load(Ordering::Relaxed)
}

fn websocket_port_open() -> bool {
    // Re-read the config every time, so a port changed in OBS is picked up.
    let Ok(Some(config)) = obs_config::read_obs_websocket_config() else { return false };
    config.enabled && TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], config.port)), PROBE_TIMEOUT).is_ok()
}

/// Emits `software-presence` whenever OBS or Streamlabs starts, stops, or becomes reachable.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last: Option<SoftwarePresence> = None;
        loop {
            let previous = last.unwrap_or_default();
            let running = scan();
            let obs_running = running.obs;
            OBS_SEEN_RUNNING.store(obs_running, Ordering::Relaxed);
            // Probe the port only while OBS runs and has not been seen ready yet, so a
            // connected session is not disturbed by a connection attempt every second.
            let obs_ready = obs_running && (previous.obs.ready || websocket_port_open());
            let streamlabs_running = running.streamlabs;
            let now = SoftwarePresence {
                obs: Presence { running: obs_running, ready: obs_ready },
                streamlabs: Presence { running: streamlabs_running, ready: streamlabs_running && slobs::available() },
            };
            if last != Some(now) {
                let _ = app.emit("software-presence", now);
                last = Some(now);
            }
            std::thread::sleep(POLL);
        }
    });
}
