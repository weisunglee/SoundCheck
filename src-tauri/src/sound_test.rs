//! Record-then-playback sound test.
//!
//! Recording takes a slice of the live tap (see `stream_tap`).
//! Playback never runs while recording, so a playback device that OBS also
//! captures cannot feed back into the recording.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SizedSample};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::loudness::{self, Summary, CHANNELS, SAMPLE_RATE};
use crate::i18n::{tr, trf};
use crate::stream_tap::StreamTapState;

pub const MAX_SECONDS: f64 = 15.0;

#[derive(Default)]
pub struct SoundTest {
    recording: Mutex<Vec<f32>>,
    stop_recording: AtomicBool,
    stop_playback: AtomicBool,
}

pub type SoundTestState = Arc<SoundTest>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaybackEvent {
    position_sec: f64,
    duration_sec: f64,
}

/// Records up to `seconds` (capped at 15) of the stream mix from the live tap, or until stopped.
#[tauri::command]
pub async fn sound_test_record(
    state: State<'_, SoundTestState>,
    tap: State<'_, StreamTapState>,
    seconds: f64,
) -> Result<Summary, String> {
    let test = state.inner().clone();
    let tap = tap.inner().clone();
    let seconds = seconds.clamp(1.0, MAX_SECONDS);
    tauri::async_runtime::spawn_blocking(move || {
        test.stop_recording.store(false, Ordering::SeqCst);
        let mut samples = tap.record(seconds, &test.stop_recording)?;
        samples.truncate(samples.len() / CHANNELS * CHANNELS);
        let summary = loudness::summarize(&samples);
        *test.recording.lock().unwrap() = samples;
        Ok(summary)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn sound_test_stop_recording(state: State<'_, SoundTestState>) {
    state.stop_recording.store(true, Ordering::SeqCst);
}

/// Plays the last recording on the default output device; resolves when it ends or is stopped.
#[tauri::command]
pub async fn sound_test_play(app: AppHandle, state: State<'_, SoundTestState>) -> Result<(), String> {
    let test = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || play(&app, &test))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn sound_test_stop_playback(state: State<'_, SoundTestState>) {
    state.stop_playback.store(true, Ordering::SeqCst);
}

fn play(app: &AppHandle, test: &SoundTest) -> Result<(), String> {
    test.stop_playback.store(false, Ordering::SeqCst);
    let samples = Arc::new(test.recording.lock().unwrap().clone());
    if samples.is_empty() {
        return Err(tr("還沒有錄音"));
    }

    let device = cpal::default_host().default_output_device().ok_or_else(|| tr("找不到播放裝置"))?;
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let config: cpal::StreamConfig = supported.config();

    let position = Arc::new(Mutex::new(0f64));
    let finished = Arc::new(AtomicBool::new(false));
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => build_stream::<f32>(&device, &config, &samples, &position, &finished),
        cpal::SampleFormat::I16 => build_stream::<i16>(&device, &config, &samples, &position, &finished),
        cpal::SampleFormat::U16 => build_stream::<u16>(&device, &config, &samples, &position, &finished),
        other => return Err(trf("不支援的播放格式：{format}", &[("format", &other)])),
    }?;
    stream.play().map_err(|e| e.to_string())?;

    let duration_sec = (samples.len() / CHANNELS) as f64 / f64::from(SAMPLE_RATE);
    while !finished.load(Ordering::SeqCst) && !test.stop_playback.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(50));
        let position_sec = *position.lock().unwrap() / f64::from(SAMPLE_RATE);
        let _ = app.emit("sound-test-playback", PlaybackEvent { position_sec, duration_sec });
    }
    drop(stream);
    Ok(())
}

/// Plays 48 kHz stereo `samples` on a device with any rate and channel count,
/// resampling linearly and copying left/right to the first two channels.
fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    samples: &Arc<Vec<f32>>,
    position: &Arc<Mutex<f64>>,
    finished: &Arc<AtomicBool>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    let out_channels = usize::from(config.channels);
    let step = f64::from(SAMPLE_RATE) / f64::from(config.sample_rate.0);
    let frames = samples.len() / CHANNELS;
    let (samples, position, finished) = (samples.clone(), position.clone(), finished.clone());

    device
        .build_output_stream(
            config,
            move |out: &mut [T], _| {
                let mut pos = position.lock().unwrap();
                for frame in out.chunks_mut(out_channels) {
                    let i = *pos as usize;
                    let (l, r) = if i + 1 < frames {
                        let t = (*pos - i as f64) as f32;
                        let at = |f: usize, ch: usize| samples[f * CHANNELS + ch];
                        (at(i, 0) + (at(i + 1, 0) - at(i, 0)) * t, at(i, 1) + (at(i + 1, 1) - at(i, 1)) * t)
                    } else {
                        finished.store(true, Ordering::SeqCst);
                        (0.0, 0.0)
                    };
                    for (ch, slot) in frame.iter_mut().enumerate() {
                        let v = match (ch, out_channels) {
                            (_, 1) => (l + r) * 0.5,
                            (0, _) => l,
                            (1, _) => r,
                            _ => 0.0,
                        };
                        *slot = T::from_sample(v);
                    }
                    *pos += step;
                }
            },
            |err| eprintln!("playback error: {err}"),
            None,
        )
        .map_err(|e| e.to_string())
}
