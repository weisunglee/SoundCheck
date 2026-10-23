//! The one connection to the plugin's tap of the stream mix.
//!
//! While connected it emits `stream-level` about ten times a second (peaks and
//! loudness of what the stream sends) and serves sound-test recordings from the
//! same audio, so the plugin only ever has one client.

use std::io::Read;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::loudness::{CHANNELS, LiveLoudness, SAMPLE_RATE};
use crate::i18n::{tr, trf};

/// How often the sound test's recording meter updates.
const RECORD_LEVEL_FRAMES: usize = SAMPLE_RATE as usize / 20;

#[derive(Default)]
pub struct StreamTap {
    stop: Mutex<Option<Arc<AtomicBool>>>,
    recording: Mutex<Option<Recording>>,
}

pub type StreamTapState = Arc<StreamTap>;

struct Recording {
    samples: Vec<f32>,
    target: usize,
    next_level_at: usize,
    done: mpsc::Sender<()>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamLevel {
    /// Peak per channel since the last update, 0..1.
    peaks: [f32; CHANNELS],
    momentary_lufs: Option<f64>,
    short_term_lufs: Option<f64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordLevel {
    elapsed_sec: f64,
    peaks: [f32; CHANNELS],
}

/// Starts reading the tap the plugin opened on `port`, replacing any earlier connection.
#[tauri::command]
pub fn stream_tap_start(app: AppHandle, state: State<'_, StreamTapState>, port: u16) -> Result<(), String> {
    let tap = state.inner().clone();
    tap.stop_current();
    let socket = TcpStream::connect(("127.0.0.1", port)).map_err(|e| trf("無法連到直播軟體的外掛：{e}", &[("e", &e)]))?;
    socket.set_read_timeout(Some(Duration::from_millis(200))).map_err(|e| e.to_string())?;

    let stop = Arc::new(AtomicBool::new(false));
    *tap.stop.lock().unwrap() = Some(stop.clone());
    std::thread::spawn(move || {
        tap.read_loop(&app, socket, &stop);
        // A connection that was stopped or replaced ends quietly. One that dropped by itself
        // gives up its slot (so recordings stop waiting on it) and tells the UI to restart.
        if !stop.load(Ordering::SeqCst) {
            tap.release(&stop);
            let _ = app.emit("stream-tap-ended", ());
        }
    });
    Ok(())
}

#[tauri::command]
pub fn stream_tap_stop(state: State<'_, StreamTapState>) {
    state.stop_current();
}

impl StreamTap {
    fn stop_current(&self) {
        if let Some(stop) = self.stop.lock().unwrap().take() {
            stop.store(true, Ordering::SeqCst);
        }
    }

    fn read_loop(&self, app: &AppHandle, mut socket: TcpStream, stop: &AtomicBool) {
        let mut live = LiveLoudness::default();
        let mut pending: Vec<u8> = Vec::new();
        let mut buf = [0u8; 16 * 1024];
        let mut peaks = [0f32; CHANNELS];

        while !stop.load(Ordering::SeqCst) {
            let n = match socket.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => continue,
                Err(_) => break,
            };
            pending.extend_from_slice(&buf[..n]);
            let whole = pending.len() / (4 * CHANNELS) * (4 * CHANNELS);
            let samples: Vec<f32> = pending[..whole]
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .collect();
            pending.drain(..whole);

            for frame in samples.chunks_exact(CHANNELS) {
                for (p, s) in peaks.iter_mut().zip(frame) {
                    *p = p.max(s.abs());
                }
            }
            if let Some(reading) = live.push(&samples).pop() {
                let _ = app.emit(
                    "stream-level",
                    StreamLevel { peaks, momentary_lufs: reading.momentary, short_term_lufs: reading.short_term },
                );
                peaks = [0.0; CHANNELS];
            }
            self.feed_recording(app, &samples);
        }
    }

    /// Called when the connection owning `stop` dropped on its own.
    fn release(&self, stop: &Arc<AtomicBool>) {
        let mut current = self.stop.lock().unwrap();
        if current.as_ref().is_some_and(|c| Arc::ptr_eq(c, stop)) {
            *current = None;
            // A recording waiting on this connection ends with what it has so far.
            if let Some(rec) = self.recording.lock().unwrap().as_mut() {
                rec.target = rec.samples.len();
                let _ = rec.done.send(());
            }
        }
    }

    fn feed_recording(&self, app: &AppHandle, samples: &[f32]) {
        let mut slot = self.recording.lock().unwrap();
        let Some(rec) = slot.as_mut() else { return };
        let room = rec.target - rec.samples.len();
        rec.samples.extend_from_slice(&samples[..samples.len().min(room)]);

        while rec.samples.len() >= rec.next_level_at {
            let start = rec.next_level_at - RECORD_LEVEL_FRAMES * CHANNELS;
            let mut peaks = [0f32; CHANNELS];
            for frame in rec.samples[start..rec.next_level_at].chunks_exact(CHANNELS) {
                for (p, s) in peaks.iter_mut().zip(frame) {
                    *p = p.max(s.abs());
                }
            }
            let elapsed_sec = (rec.next_level_at / CHANNELS) as f64 / f64::from(SAMPLE_RATE);
            let _ = app.emit("sound-test-level", RecordLevel { elapsed_sec, peaks });
            rec.next_level_at += RECORD_LEVEL_FRAMES * CHANNELS;
        }
        if rec.samples.len() >= rec.target {
            let _ = rec.done.send(());
        }
    }

    /// Records `seconds` of the stream mix, or less if `stop` is set or the tap ends first.
    pub fn record(&self, seconds: f64, stop: &AtomicBool) -> Result<Vec<f32>, String> {
        if self.stop.lock().unwrap().is_none() {
            return Err(tr("還沒接上直播的聲音，請確認直播軟體的外掛已經載入。"));
        }
        let (done, finished) = mpsc::channel();
        let target = (seconds * f64::from(SAMPLE_RATE)) as usize * CHANNELS;
        let mut slot = self.recording.lock().unwrap();
        if slot.is_some() {
            return Err(tr("已經在錄音了"));
        }
        *slot = Some(Recording {
            samples: Vec::with_capacity(target),
            target,
            next_level_at: RECORD_LEVEL_FRAMES * CHANNELS,
            done,
        });
        drop(slot);

        loop {
            match finished.recv_timeout(Duration::from_millis(100)) {
                Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) if stop.load(Ordering::SeqCst) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
        let samples = self.recording.lock().unwrap().take().map(|r| r.samples).unwrap_or_default();
        if samples.is_empty() {
            return Err(tr("錄音時沒有收到聲音，和外掛的連線可能中斷了。"));
        }
        Ok(samples)
    }
}
