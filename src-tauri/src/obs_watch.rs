//! Watches for OBS starting and stopping from a native thread.
//!
//! The webview's own retry timer is not enough: Windows WebView2 throttles and
//! eventually suspends timers in a minimized or hidden window, so a user who
//! opens OBS while this app is in the background could wait a minute or more.

use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::obs_config;
use crate::plugin_install::obs_running;

const POLL: Duration = Duration::from_secs(1);
const PROBE_TIMEOUT: Duration = Duration::from_millis(300);

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ObsPresence {
    running: bool,
    /// OBS is running and its WebSocket port accepts connections.
    ready: bool,
}

fn websocket_port_open() -> bool {
    // Re-read the config every time, so a port changed in OBS is picked up.
    let Ok(Some(config)) = obs_config::read_obs_websocket_config() else { return false };
    config.enabled && TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], config.port)), PROBE_TIMEOUT).is_ok()
}

/// Emits `obs-presence` whenever OBS starts, stops, or its WebSocket server becomes reachable.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last: Option<ObsPresence> = None;
        loop {
            let running = obs_running();
            // Probe the port only while OBS runs and has not been seen ready yet, so a
            // connected session is not disturbed by a connection attempt every second.
            let ready = running && (last.is_some_and(|l| l.ready) || websocket_port_open());
            let now = ObsPresence { running, ready };
            if last != Some(now) {
                let _ = app.emit("obs-presence", now);
                last = Some(now);
            }
            std::thread::sleep(POLL);
        }
    });
}
