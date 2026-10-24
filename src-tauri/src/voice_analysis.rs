//! Voice analysis for the voice tuning: reads a recording of someone talking into their mic
//! (mono float PCM from the plugin's analyzer filter, taken before the mic's filters) and works
//! out the filter settings that would make it sound better.
//!
//! The rules here are deliberately conservative: a recording with a problem the filters can't
//! fix (too quiet, clipping, too noisy, too little talking) gets no EQ, only the problem, so the
//! UI can ask the user to fix it and record again.

use serde::Serialize;

use crate::i18n::tr;

/// Integrated loudness the chain aims the voice at, before the source's fader.
pub const TARGET_LUFS: f64 = -16.0;

/// A sample at or above this magnitude counts as clipped.
const CLIP_LEVEL: f32 = 0.99;
/// Analysis frame for level, noise and voice activity.
const FRAME_SEC: f64 = 0.02;

/// Byrne et al. (1994), "An international comparison of long-term average speech spectra",
/// JASA 96(4): the universal LTASS, 1/3-octave band levels in dB SPL for speech at 70 dB SPL
/// overall. Only the shape matters here: it is compared after aligning the levels.
const LTASS: [(f64, f64); 21] = [
    (100.0, 54.4),
    (125.0, 57.7),
    (160.0, 56.8),
    (200.0, 60.2),
    (250.0, 60.3),
    (315.0, 59.0),
    (400.0, 62.1),
    (500.0, 62.1),
    (630.0, 60.5),
    (800.0, 56.8),
    (1000.0, 53.7),
    (1250.0, 53.0),
    (1600.0, 52.0),
    (2000.0, 48.7),
    (2500.0, 48.1),
    (3150.0, 46.8),
    (4000.0, 45.6),
    (5000.0, 44.5),
    (6300.0, 44.3),
    (8000.0, 43.7),
    (10000.0, 43.4),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IssueKind {
    /// Nothing came in.
    Silent,
    /// Too little talking to analyze.
    TooShort,
    /// The voice is far below a usable level; the mic gain is too low.
    TooQuiet,
    /// The recording clipped; the mic gain is too high.
    Clipping,
    /// Peaks come close to clipping.
    NearClipping,
    /// The background is too loud compared with the voice to analyze it.
    TooNoisy,
    /// Some background noise; noise suppression is added.
    SomeNoise,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub kind: IssueKind,
    /// The recording can't be tuned until this is fixed.
    pub blocking: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Band {
    pub freq: f64,
    pub gain_db: f64,
    pub q: f64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeEsser {
    pub freq: f64,
    pub threshold_db: f64,
    pub max_reduction_db: f64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Compressor {
    pub threshold_db: f64,
    pub ratio: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
    pub output_gain_db: f64,
}

/// Filter settings for the chain, in the order they run (see src/voiceTuning.ts).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub noise_suppression: bool,
    pub highpass_hz: f64,
    pub mud: Option<Band>,
    pub de_esser: Option<DeEsser>,
    pub compressor: Compressor,
    /// Gain the compressor's makeup can't give (or a cut when the voice is too loud).
    pub gain_db: f64,
    pub presence: Option<Band>,
    pub air: Option<Band>,
    pub limiter_db: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BandLevel {
    pub freq: f64,
    /// How far the voice is above (+) or below (-) the average speech spectrum.
    pub deviation_db: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub duration_sec: f64,
    pub voiced_sec: f64,
    pub peak_dbfs: Option<f64>,
    pub clipped_samples: usize,
    /// Typical level while talking (median 20 ms RMS), dBFS.
    pub speech_dbfs: Option<f64>,
    /// Level of the quietest moments, dBFS.
    pub noise_dbfs: Option<f64>,
    pub loudness_lufs: Option<f64>,
    /// Median pitch while talking, Hz.
    pub pitch_hz: Option<f64>,
    /// Low end of the pitch range (10th percentile), Hz.
    pub pitch_low_hz: Option<f64>,
    pub bands: Vec<BandLevel>,
    pub issues: Vec<Issue>,
    /// `None` when a blocking issue stops the tuning.
    pub plan: Option<Plan>,
}

/// Analyzes the recording the app read from the plugin, as base64 chunks of mono f32 LE PCM.
#[tauri::command]
pub async fn voice_analyze(chunks: Vec<String>, sample_rate: u32) -> Result<Analysis, String> {
    if !(8_000..=192_000).contains(&sample_rate) {
        return Err(tr("錄音的取樣率不正確"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut samples = Vec::new();
        for chunk in &chunks {
            let bytes = decode_base64(chunk).ok_or_else(|| tr("外掛傳來的錄音格式不正確"))?;
            samples.extend(bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])));
        }
        Ok(analyze(&samples, sample_rate))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn analyze(samples: &[f32], rate: u32) -> Analysis {
    let fs = f64::from(rate);
    let duration_sec = samples.len() as f64 / fs;
    let peak = samples.iter().fold(0f32, |m, s| m.max(s.abs()));
    let clipped_samples = samples.iter().filter(|s| s.abs() >= CLIP_LEVEL).count();

    let frame = (FRAME_SEC * fs) as usize;
    let frame_db: Vec<f64> = samples.chunks_exact(frame).map(rms_db).collect();
    let voiced = voice_activity(&frame_db);
    let voiced_db: Vec<f64> = frame_db.iter().zip(&voiced).filter(|(_, v)| **v).map(|(d, _)| *d).collect();
    let voiced_sec = voiced_db.len() as f64 * FRAME_SEC;
    let noise_dbfs = (!frame_db.is_empty()).then(|| percentile(&frame_db, 0.1));
    let speech_dbfs = (!voiced_db.is_empty()).then(|| percentile(&voiced_db, 0.5));

    let mut analysis = Analysis {
        duration_sec,
        voiced_sec,
        peak_dbfs: (peak > 0.0).then(|| 20.0 * f64::from(peak).log10()),
        clipped_samples,
        speech_dbfs,
        noise_dbfs,
        loudness_lufs: None,
        pitch_hz: None,
        pitch_low_hz: None,
        bands: Vec::new(),
        issues: Vec::new(),
        plan: None,
    };

    let issue = |kind, blocking| Issue { kind, blocking };
    let (Some(speech), Some(noise)) = (speech_dbfs, noise_dbfs) else {
        analysis.issues.push(issue(IssueKind::Silent, true));
        return analysis;
    };
    if analysis.peak_dbfs.is_none_or(|p| p < -60.0) {
        analysis.issues.push(issue(IssueKind::Silent, true));
        return analysis;
    }
    let snr = speech - noise;
    if voiced_sec < 4.0 {
        analysis.issues.push(issue(IssueKind::TooShort, true));
    }
    if speech < -48.0 {
        analysis.issues.push(issue(IssueKind::TooQuiet, true));
    }
    if clipped_samples >= 10 {
        analysis.issues.push(issue(IssueKind::Clipping, true));
    } else if analysis.peak_dbfs.is_some_and(|p| p > -1.0) {
        analysis.issues.push(issue(IssueKind::NearClipping, false));
    }
    if snr < 15.0 {
        analysis.issues.push(issue(IssueKind::TooNoisy, true));
    } else if snr < 30.0 || noise > -55.0 {
        analysis.issues.push(issue(IssueKind::SomeNoise, false));
    }

    let k = k_weighted(samples, fs);
    analysis.loudness_lufs = integrated_loudness(&k, rate);

    let pitches = pitch_track(samples, fs, &voiced, frame);
    if pitches.len() >= 20 {
        analysis.pitch_hz = Some(percentile(&pitches, 0.5));
        analysis.pitch_low_hz = Some(percentile(&pitches, 0.1));
    }

    let spectrum = Spectrum::measure(samples, fs, &voiced, frame);
    analysis.bands = spectrum.deviations();

    if analysis.issues.iter().any(|i| i.blocking) {
        return analysis;
    }

    let highpass_hz = match analysis.pitch_low_hz {
        Some(low) => round_to(0.75 * low, 5.0).clamp(60.0, 100.0),
        None => 80.0,
    };
    let dev = |f: f64| analysis.bands.iter().find(|b| b.freq == f).map_or(0.0, |b| b.deviation_db);

    // Mud: the strongest 1/3 octave between 200 and 500 Hz, cut when it stands out more than 3 dB.
    let mud = [200.0, 250.0, 315.0, 400.0, 500.0]
        .into_iter()
        .map(|f| (f, dev(f)))
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .filter(|(_, d)| *d > 3.0)
        .map(|(freq, d)| Band { freq, gain_db: -round_to((d - 1.0).min(6.0), 0.5), q: 1.4 });

    // Presence: 2-5 kHz on average below the speech spectrum.
    let presence_bands = [2000.0, 2500.0, 3150.0, 4000.0, 5000.0];
    let presence_mean = presence_bands.iter().map(|&f| dev(f)).sum::<f64>() / presence_bands.len() as f64;
    let presence = (presence_mean < -2.0).then(|| {
        let freq = presence_bands.into_iter().min_by(|a, b| dev(*a).total_cmp(&dev(*b))).unwrap_or(3150.0);
        Band { freq, gain_db: round_to((-presence_mean).min(4.0), 0.5), q: 1.0 }
    });

    // Sibilance: 5-9 kHz clearly above the speech spectrum.
    let de_esser = [5000.0, 6300.0, 8000.0]
        .into_iter()
        .map(|f| (f, dev(f)))
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .filter(|(_, d)| *d > 3.0)
        .and_then(|(freq, _)| {
            let threshold = percentile(&spectrum.sibilance_db, 0.8);
            threshold.is_finite().then(|| DeEsser { freq, threshold_db: round_to(threshold, 0.5), max_reduction_db: 6.0 })
        });

    // Air: the top octave is weak, but there is real voice up there above a quiet background,
    // and no sibilance that a lift would make worse.
    let air = (de_esser.is_none() && dev(10000.0) < -3.0 && noise < -60.0 && spectrum.air_snr_db > 15.0)
        .then(|| Band { freq: 10000.0, gain_db: round_to((-dev(10000.0)).min(3.0), 0.5), q: 0.7 });

    let (compressor, gain_db) = plan_dynamics(samples, &k, fs, &voiced, frame);

    analysis.plan = Some(Plan {
        noise_suppression: analysis.issues.iter().any(|i| i.kind == IssueKind::SomeNoise),
        highpass_hz,
        mud,
        de_esser,
        compressor,
        gain_db,
        presence,
        air,
        limiter_db: -2.0,
    });
    analysis
}

fn rms_db(frame: &[f32]) -> f64 {
    let ms = frame.iter().map(|&s| f64::from(s) * f64::from(s)).sum::<f64>() / frame.len().max(1) as f64;
    if ms > 0.0 { 10.0 * ms.log10() } else { -120.0 }
}

/// The value below which `p` (0..1) of `values` fall.
fn percentile(values: &[f64], p: f64) -> f64 {
    if values.is_empty() {
        return f64::NAN;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

fn round_to(v: f64, step: f64) -> f64 {
    // Adding zero turns -0.0 into 0.0, so a "no change" never reads as "-0".
    (v / step).round() * step + 0.0
}

/// Which 20 ms frames have someone talking: well above the background, not too far below the
/// loudest talking, and with a short hold so the ends of words count.
fn voice_activity(frame_db: &[f64]) -> Vec<bool> {
    if frame_db.is_empty() {
        return Vec::new();
    }
    let noise = percentile(frame_db, 0.1);
    let loud = percentile(frame_db, 0.95);
    let threshold = (noise + 10.0).max(loud - 35.0).max(-65.0);
    const HOLD: usize = 3;
    let mut voiced = vec![false; frame_db.len()];
    let mut hold = 0;
    for (v, &db) in voiced.iter_mut().zip(frame_db) {
        if db > threshold {
            hold = HOLD;
            *v = true;
        } else if hold > 0 {
            hold -= 1;
            *v = true;
        }
    }
    voiced
}

/// Pitch (Hz) of the voiced frames, by YIN on a copy decimated to about 16 kHz.
fn pitch_track(samples: &[f32], fs: f64, voiced: &[bool], frame: usize) -> Vec<f64> {
    let factor = ((fs / 16_000.0).round() as usize).max(1);
    let low_rate = fs / factor as f64;
    let decimated: Vec<f64> = samples
        .chunks_exact(factor)
        .map(|c| c.iter().map(|&s| f64::from(s)).sum::<f64>() / factor as f64)
        .collect();
    let window = (0.04 * low_rate) as usize;
    let min_lag = (low_rate / 400.0) as usize;
    let max_lag = (low_rate / 60.0) as usize;
    let hop = frame / factor;

    let mut pitches = Vec::new();
    let mut start = 0;
    while start + window + max_lag < decimated.len() {
        let frame_index = start * factor / frame;
        if voiced.get(frame_index).copied().unwrap_or(false)
            && let Some(f0) = yin(&decimated[start..start + window + max_lag], window, min_lag, max_lag, low_rate)
        {
            pitches.push(f0);
        }
        start += hop;
    }
    pitches
}

/// de Cheveigné & Kawahara's YIN on one frame: `x` holds `window + max_lag` samples.
fn yin(x: &[f64], window: usize, min_lag: usize, max_lag: usize, rate: f64) -> Option<f64> {
    const THRESHOLD: f64 = 0.15;
    let mut d = vec![0.0; max_lag + 1];
    for (lag, slot) in d.iter_mut().enumerate().skip(1) {
        *slot = (0..window).map(|j| (x[j] - x[j + lag]).powi(2)).sum();
    }
    // Cumulative mean normalized difference.
    let mut cmnd = vec![1.0; max_lag + 1];
    let mut running = 0.0;
    for lag in 1..=max_lag {
        running += d[lag];
        cmnd[lag] = if running > 0.0 { d[lag] * lag as f64 / running } else { 1.0 };
    }
    let mut lag = min_lag.max(2);
    while lag < max_lag {
        if cmnd[lag] < THRESHOLD {
            while lag + 1 < max_lag && cmnd[lag + 1] < cmnd[lag] {
                lag += 1;
            }
            // Parabolic interpolation around the minimum.
            let (a, b, c) = (cmnd[lag - 1], cmnd[lag], cmnd[lag + 1]);
            let denom = a - 2.0 * b + c;
            let shift = if denom.abs() > 1e-12 { 0.5 * (a - c) / denom } else { 0.0 };
            return Some(rate / (lag as f64 + shift.clamp(-1.0, 1.0)));
        }
        lag += 1;
    }
    None
}

/// Long-term average spectrum of the talking, in 1/3-octave bands.
struct Spectrum {
    /// Power per LTASS band while talking.
    voiced: Vec<f64>,
    /// Level (dBFS) of the 5-9 kHz band in each talking frame, for the de-esser's threshold.
    sibilance_db: Vec<f64>,
    /// How far the 10 kHz band is above the background, dB.
    air_snr_db: f64,
}

impl Spectrum {
    fn measure(samples: &[f32], fs: f64, voiced: &[bool], frame: usize) -> Self {
        let n = (0.085 * fs).log2().ceil().exp2() as usize;
        let window: Vec<f64> = (0..n).map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n as f64).cos()).collect();
        let window_power: f64 = window.iter().map(|w| w * w).sum();
        let bin_hz = fs / n as f64;
        let band_bins: Vec<(usize, usize)> = LTASS
            .iter()
            .map(|&(fc, _)| {
                let lo = (fc * 2f64.powf(-1.0 / 6.0) / bin_hz).ceil() as usize;
                let hi = ((fc * 2f64.powf(1.0 / 6.0) / bin_hz).ceil() as usize).max(lo + 1);
                (lo, hi.min(n / 2))
            })
            .collect();
        let sib = ((5000.0 / bin_hz) as usize, ((9000.0 / bin_hz) as usize).min(n / 2));

        let mut voiced_power = vec![0.0; LTASS.len()];
        let mut quiet_power = vec![0.0; LTASS.len()];
        let (mut voiced_count, mut quiet_count) = (0usize, 0usize);
        let mut sibilance_db = Vec::new();
        let mut re = vec![0.0; n];
        let mut im = vec![0.0; n];
        let mut start = 0;
        while start + n <= samples.len() {
            let frames = &voiced[(start / frame).min(voiced.len())..((start + n) / frame).min(voiced.len())];
            let talking = frames.iter().filter(|v| **v).count();
            let kind = if frames.is_empty() {
                None
            } else if talking * 2 > frames.len() {
                Some(true)
            } else if talking == 0 {
                Some(false)
            } else {
                None
            };
            if let Some(is_voiced) = kind {
                for i in 0..n {
                    re[i] = f64::from(samples[start + i]) * window[i];
                    im[i] = 0.0;
                }
                fft(&mut re, &mut im);
                let power = |k: usize| re[k] * re[k] + im[k] * im[k];
                let target = if is_voiced { &mut voiced_power } else { &mut quiet_power };
                for (t, &(lo, hi)) in target.iter_mut().zip(&band_bins) {
                    *t += (lo..hi).map(power).sum::<f64>();
                }
                if is_voiced {
                    voiced_count += 1;
                    // Parseval: twice the positive bins over N·Σw² is the band's mean square.
                    let ms = 2.0 * (sib.0..sib.1).map(power).sum::<f64>() / (n as f64 * window_power);
                    sibilance_db.push(if ms > 0.0 { 10.0 * ms.log10() } else { -120.0 });
                } else {
                    quiet_count += 1;
                }
            }
            start += n / 2;
        }
        let mean = |p: &mut Vec<f64>, count: usize| p.iter_mut().for_each(|v| *v /= count.max(1) as f64);
        mean(&mut voiced_power, voiced_count);
        mean(&mut quiet_power, quiet_count);

        let air = LTASS.len() - 1;
        let air_snr_db = if quiet_count == 0 {
            // No pause to measure the background in: assume it is as loud as it can be.
            0.0
        } else {
            10.0 * (voiced_power[air].max(1e-30) / quiet_power[air].max(1e-30)).log10()
        };
        Self { voiced: voiced_power, sibilance_db, air_snr_db }
    }

    /// Each band's level against the LTASS, aligned on the median difference over 160 Hz-6.3 kHz.
    fn deviations(&self) -> Vec<BandLevel> {
        if self.voiced.iter().all(|p| *p <= 0.0) {
            return Vec::new();
        }
        let raw: Vec<f64> = self.voiced.iter().zip(&LTASS).map(|(p, (_, l))| 10.0 * p.max(1e-30).log10() - l).collect();
        let core: Vec<f64> = raw.iter().zip(&LTASS).filter(|(_, (f, _))| (160.0..=6300.0).contains(f)).map(|(d, _)| *d).collect();
        let offset = percentile(&core, 0.5);
        raw.iter()
            .zip(&LTASS)
            .map(|(d, (freq, _))| BandLevel { freq: *freq, deviation_db: round_to(d - offset, 0.1) })
            .collect()
    }
}

/// In-place radix-2 FFT; the length must be a power of two.
fn fft(re: &mut [f64], im: &mut [f64]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let angle = -2.0 * std::f64::consts::PI / len as f64;
        let (wr, wi) = (angle.cos(), angle.sin());
        for start in (0..n).step_by(len) {
            let (mut cr, mut ci) = (1.0, 0.0);
            for k in 0..len / 2 {
                let (a, b) = (start + k, start + k + len / 2);
                let tr = re[b] * cr - im[b] * ci;
                let ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                (cr, ci) = (cr * wr - ci * wi, cr * wi + ci * wr);
            }
        }
        len <<= 1;
    }
}

struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
    z: [f64; 2],
}

impl Biquad {
    fn new(b: [f64; 3], a0: f64, a: [f64; 2]) -> Self {
        Self { b: b.map(|v| v / a0), a: a.map(|v| v / a0), z: [0.0; 2] }
    }

    fn process(&mut self, x: f64) -> f64 {
        let y = self.b[0] * x + self.z[0];
        self.z[0] = self.b[1] * x - self.a[0] * y + self.z[1];
        self.z[1] = self.b[2] * x - self.a[1] * y;
        y
    }
}

/// BS.1770 K-weighting at any sample rate, designed as libebur128 does (at 48 kHz this gives the
/// standard's coefficients exactly).
fn k_weighted(samples: &[f32], fs: f64) -> Vec<f64> {
    let (fc, gain_db, q) = (1_681.974_450_955_533, 3.999_843_853_973_347, 0.707_175_236_955_419_6);
    let k = (std::f64::consts::PI * fc / fs).tan();
    let vh = 10f64.powf(gain_db / 20.0);
    let vb = vh.powf(0.499_666_774_154_541_6);
    let a0 = 1.0 + k / q + k * k;
    let mut shelf = Biquad::new([vh + vb * k / q + k * k, 2.0 * (k * k - vh), vh - vb * k / q + k * k], a0, [2.0 * (k * k - 1.0), 1.0 - k / q + k * k]);
    let (fc, q) = (38.135_470_876_024_44, 0.500_327_037_323_877_3);
    let k = (std::f64::consts::PI * fc / fs).tan();
    let a0 = 1.0 + k / q + k * k;
    let mut highpass = Biquad::new([a0, -2.0 * a0, a0], a0, [2.0 * (k * k - 1.0), 1.0 - k / q + k * k]);
    samples.iter().map(|&s| highpass.process(shelf.process(f64::from(s)))).collect()
}

/// BS.1770 integrated loudness of a K-weighted mono signal played on both stereo channels.
fn integrated_loudness(k: &[f64], rate: u32) -> Option<f64> {
    let step = rate as usize / 10;
    let steps: Vec<f64> = k.chunks_exact(step).map(|c| c.iter().map(|y| y * y).sum()).collect();
    if steps.len() < 4 {
        return None;
    }
    // Both channels carry the signal: twice the energy of one.
    let blocks: Vec<f64> = steps.windows(4).map(|w| 2.0 * w.iter().sum::<f64>() / (4 * step) as f64).collect();
    let loudness = |z: f64| -0.691 + 10.0 * z.max(1e-30).log10();
    let gated_mean = |threshold: f64| {
        let kept: Vec<f64> = blocks.iter().copied().filter(|&z| loudness(z) > threshold).collect();
        (!kept.is_empty()).then(|| kept.iter().sum::<f64>() / kept.len() as f64)
    };
    let absolute = gated_mean(-70.0)?;
    Some(loudness(gated_mean(loudness(absolute) - 10.0)?))
}

const ATTACK_MS: f64 = 5.0;
const RELEASE_MS: f64 = 80.0;
const MAX_OUTPUT_GAIN_DB: f64 = 20.0;

/// Peak envelope like OBS's compressor detector, in dBFS per sample.
fn envelope_db(samples: &[f32], fs: f64) -> Vec<f64> {
    let attack = (-1.0 / (ATTACK_MS * 0.001 * fs)).exp();
    let release = (-1.0 / (RELEASE_MS * 0.001 * fs)).exp();
    let mut env = 0.0;
    samples
        .iter()
        .map(|&s| {
            let x = f64::from(s.abs());
            let c = if x > env { attack } else { release };
            env = c * env + (1.0 - c) * x;
            20.0 * env.max(1e-9).log10()
        })
        .collect()
}

/// The compressor that evens out the talking, and the gain that brings it to TARGET_LUFS.
fn plan_dynamics(samples: &[f32], k: &[f64], fs: f64, voiced: &[bool], frame: usize) -> (Compressor, f64) {
    let env = envelope_db(samples, fs);
    // The envelope's peak in each talking 20 ms frame.
    let frame_peaks: Vec<f64> = env
        .chunks(frame)
        .zip(voiced)
        .filter(|(_, v)| **v)
        .map(|(c, _)| c.iter().copied().fold(f64::MIN, f64::max))
        .collect();
    let (p20, p95) = (percentile(&frame_peaks, 0.2), percentile(&frame_peaks, 0.95));
    let spread = p95 - p20;
    let ratio = if spread >= 22.0 {
        4.0
    } else if spread >= 15.0 {
        3.0
    } else {
        2.0
    };
    // About 6 dB of gain reduction on the loud end of the talking.
    let threshold = (p95 - 6.0 / (1.0 - 1.0 / ratio)).clamp(percentile(&frame_peaks, 0.3), percentile(&frame_peaks, 0.8));
    let threshold = round_to(threshold, 0.5);

    let compressed: Vec<f64> = k
        .iter()
        .zip(&env)
        .map(|(y, e)| {
            let reduction = if *e > threshold { (threshold - e) * (1.0 - 1.0 / ratio) } else { 0.0 };
            y * 10f64.powf(reduction / 20.0)
        })
        .collect();
    let needed = integrated_loudness(&compressed, fs as u32).map_or(0.0, |l| TARGET_LUFS - l);
    let output_gain = round_to(needed.clamp(0.0, MAX_OUTPUT_GAIN_DB), 0.5);
    let gain = round_to(needed - output_gain, 0.5);
    (
        Compressor { threshold_db: threshold, ratio, attack_ms: ATTACK_MS, release_ms: RELEASE_MS, output_gain_db: output_gain },
        gain,
    )
}

fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let bytes = text.trim_end_matches('=').as_bytes();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let mut v = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            v |= value(c)? << (18 - 6 * i);
        }
        let n = match chunk.len() {
            4 => 3,
            3 => 2,
            2 => 1,
            _ => return None,
        };
        out.extend_from_slice(&v.to_be_bytes()[1..=n]);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    const FS: u32 = 48_000;

    /// Deterministic white noise in -1..1.
    struct Noise(u64);
    impl Noise {
        fn next(&mut self) -> f64 {
            self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            ((self.0 >> 11) as f64 / (1u64 << 53) as f64) * 2.0 - 1.0
        }
    }

    fn ltass_db(f: f64) -> f64 {
        let i = LTASS.iter().position(|(fc, _)| *fc >= f).unwrap_or(LTASS.len() - 1).max(1);
        let ((f0, l0), (f1, l1)) = (LTASS[i - 1], LTASS[i]);
        let t = ((f.log2() - f0.log2()) / (f1.log2() - f0.log2())).clamp(0.0, 1.0);
        l0 + (l1 - l0) * t
    }

    struct Voice {
        f0: f64,
        seconds: f64,
        /// Speech level: amplitude of the loudest syllables.
        level: f64,
        noise: f64,
        /// Extra dB for harmonics in (lo, hi) Hz.
        tilt: Vec<(f64, f64, f64)>,
        /// Bursts of 5-9 kHz noise this loud (amplitude), like "s" sounds.
        hiss: f64,
    }

    impl Default for Voice {
        fn default() -> Self {
            Self { f0: 120.0, seconds: 12.0, level: 0.3, noise: 0.0003, tilt: Vec::new(), hiss: 0.0 }
        }
    }

    /// Syllables of a harmonic voice shaped like the LTASS, 4 per second, with a pause every 3 s.
    fn voice(v: &Voice) -> Vec<f32> {
        let fs = f64::from(FS);
        let frames = (v.seconds * fs) as usize;
        let mut noise = Noise(7);
        let harmonics: Vec<(f64, f64)> = (1..)
            .map(|h| h as f64 * v.f0)
            .take_while(|f| *f < 11_000.0)
            .map(|f| {
                // A band holds bandwidth/f0 harmonics, so each gets that share of the band level.
                let per_harmonic = ltass_db(f.max(100.0)) - 10.0 * (0.2316 * f.max(100.0) / v.f0).max(1.0).log10();
                let extra: f64 = v.tilt.iter().filter(|(lo, hi, _)| f > *lo && f < *hi).map(|t| t.2).sum();
                (f, per_harmonic + extra)
            })
            .collect();
        let top = harmonics.iter().map(|h| h.1).fold(f64::MIN, f64::max);
        let amps: Vec<(f64, f64)> = harmonics.iter().map(|&(f, db)| (f, 10f64.powf((db - top) / 20.0))).collect();
        let norm: f64 = amps.iter().map(|a| a.1).sum();

        // A crude 5-9 kHz band for the hiss: the difference of two one-pole low-passes.
        let (mut lp_a, mut lp_b) = (0.0, 0.0);
        let ka = 1.0 - (-2.0 * PI * 9000.0 / fs).exp();
        let kb = 1.0 - (-2.0 * PI * 5000.0 / fs).exp();
        let mut phases = vec![0.0; amps.len()];
        (0..frames)
            .map(|i| {
                let t = i as f64 / fs;
                let in_pause = t % 3.0 > 2.4;
                let syllable = (t * 4.0).fract();
                let env = if in_pause || syllable > 0.75 { 0.0 } else { (PI * syllable / 0.75).sin() };
                // Each syllable a little louder or softer, and the pitch moving a bit.
                let strength = 0.5 + 0.5 * ((t * 4.0).floor() * 1.7).sin().abs();
                let pitch = 1.0 + 0.08 * (2.0 * PI * 0.7 * t).sin();
                let mut s = 0.0;
                for ((f, a), ph) in amps.iter().zip(phases.iter_mut()) {
                    *ph += 2.0 * PI * f * pitch / fs;
                    s += a * ph.sin();
                }
                let mut x = v.level * env * strength * s / norm * 3.0;
                let n = noise.next();
                if v.hiss > 0.0 && !in_pause && syllable > 0.55 && syllable < 0.75 {
                    lp_a += ka * (n - lp_a);
                    lp_b += kb * (n - lp_b);
                    x += v.hiss * (lp_a - lp_b) * 4.0;
                }
                (x + v.noise * n) as f32
            })
            .collect()
    }

    fn plan(a: &Analysis) -> &Plan {
        a.plan.as_ref().unwrap_or_else(|| panic!("no plan: {:?}", a.issues))
    }

    #[test]
    fn fft_finds_a_sine_bin() {
        let n = 1024;
        let mut re: Vec<f64> = (0..n).map(|i| (2.0 * PI * 37.0 * i as f64 / n as f64).sin()).collect();
        let mut im = vec![0.0; n];
        fft(&mut re, &mut im);
        let peak = (0..n / 2).max_by(|&a, &b| (re[a].hypot(im[a])).total_cmp(&re[b].hypot(im[b]))).unwrap();
        assert_eq!(peak, 37);
        assert!((re[37].hypot(im[37]) - n as f64 / 2.0).abs() < 1e-6);
    }

    #[test]
    fn yin_finds_the_pitch_of_a_harmonic_tone() {
        let rate = 16_000.0;
        let x: Vec<f64> = (0..2000)
            .map(|i| (1..6).map(|h| (2.0 * PI * 150.0 * h as f64 * i as f64 / rate).sin() / h as f64).sum())
            .collect();
        let f0 = yin(&x, 640, 40, 266, rate).unwrap();
        assert!((f0 - 150.0).abs() < 1.0, "got {f0}");
    }

    #[test]
    fn k_weighted_loudness_matches_bs1770_at_any_rate() {
        for rate in [44_100u32, 48_000] {
            let fs = f64::from(rate);
            let tone: Vec<f32> = (0..rate as usize * 3).map(|i| (0.1 * (2.0 * PI * 1000.0 * i as f64 / fs).sin()) as f32).collect();
            let lufs = integrated_loudness(&k_weighted(&tone, fs), rate).unwrap();
            // A -20 dBFS 1 kHz sine on both channels reads -20 LUFS (see loudness.rs).
            assert!((lufs + 20.0).abs() < 0.1, "{rate} Hz: {lufs}");
        }
    }

    #[test]
    fn base64_round_trips_floats() {
        // "AACAPwAAAMA=" is 1.0 and -2.0 as little-endian f32.
        let bytes = decode_base64("AACAPwAAAMA=").unwrap();
        let floats: Vec<f32> = bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
        assert_eq!(floats, [1.0, -2.0]);
        assert_eq!(decode_base64("TWE=").unwrap(), b"Ma");
        assert!(decode_base64("@@@@").is_none());
    }

    #[test]
    fn an_average_voice_gets_only_a_highpass_and_dynamics() {
        let a = analyze(&voice(&Voice::default()), FS);
        let p = plan(&a);
        assert!(a.issues.is_empty(), "{:?}", a.issues);
        let pitch = a.pitch_hz.unwrap();
        assert!((pitch - 120.0).abs() < 8.0, "pitch {pitch}");
        assert!(p.mud.is_none() && p.presence.is_none() && p.de_esser.is_none(), "{p:?} {:?}", a.bands);
        assert!((60.0..=90.0).contains(&p.highpass_hz), "{}", p.highpass_hz);
        assert!(!p.noise_suppression);
    }

    #[test]
    fn a_higher_voice_is_cut_higher_but_never_above_100_hz() {
        let low = plan(&analyze(&voice(&Voice { f0: 95.0, ..Voice::default() }), FS)).highpass_hz;
        let high = analyze(&voice(&Voice { f0: 230.0, ..Voice::default() }), FS);
        assert!(high.pitch_hz.unwrap() > 200.0);
        let high = plan(&high).highpass_hz;
        assert!(low < high, "{low} vs {high}");
        assert_eq!(high, 100.0);
        assert!(low >= 60.0);
    }

    #[test]
    fn a_muddy_voice_gets_a_cut_between_200_and_500_hz() {
        let a = analyze(&voice(&Voice { tilt: vec![(220.0, 450.0, 9.0)], ..Voice::default() }), FS);
        let mud = plan(&a).mud.unwrap_or_else(|| panic!("no mud cut: {:?}", a.bands));
        assert!((250.0..=400.0).contains(&mud.freq), "{mud:?}");
        assert!(mud.gain_db < -1.0 && mud.gain_db >= -6.0, "{mud:?}");
    }

    #[test]
    fn mud_cuts_stop_at_6_db() {
        let a = analyze(&voice(&Voice { tilt: vec![(220.0, 450.0, 20.0)], ..Voice::default() }), FS);
        assert_eq!(plan(&a).mud.unwrap().gain_db, -6.0);
    }

    #[test]
    fn a_dull_voice_gets_presence_up_to_4_db() {
        let a = analyze(&voice(&Voice { tilt: vec![(1900.0, 5500.0, -12.0)], ..Voice::default() }), FS);
        let presence = plan(&a).presence.unwrap_or_else(|| panic!("no presence: {:?}", a.bands));
        assert!((2000.0..=5000.0).contains(&presence.freq));
        assert_eq!(presence.gain_db, 4.0);
    }

    #[test]
    fn strong_sibilance_turns_on_the_de_esser_and_no_air() {
        let a = analyze(&voice(&Voice { hiss: 0.15, ..Voice::default() }), FS);
        let p = plan(&a);
        let d = p.de_esser.unwrap_or_else(|| panic!("no de-esser: {:?}", a.bands));
        assert!((5000.0..=8000.0).contains(&d.freq));
        assert!(d.threshold_db < 0.0 && d.threshold_db > -60.0, "{d:?}");
        assert!(p.air.is_none());
    }

    #[test]
    fn a_band_limited_voice_gets_no_air_lift() {
        // Nothing above 8 kHz at all, like a cheap headset: the top is weak but there is no
        // voice up there to lift.
        let a = analyze(&voice(&Voice { tilt: vec![(7000.0, 20_000.0, -60.0)], ..Voice::default() }), FS);
        assert!(plan(&a).air.is_none());
    }

    #[test]
    fn a_quieter_mic_gets_more_makeup_gain() {
        let loud = plan(&analyze(&voice(&Voice::default()), FS)).clone();
        let quiet = plan(&analyze(&voice(&Voice { level: 0.075, noise: 0.000_075, ..Voice::default() }), FS)).clone();
        let total = |p: &Plan| p.compressor.output_gain_db + p.gain_db;
        // 12 dB quieter needs about 12 dB more gain.
        assert!((total(&quiet) - total(&loud) - 12.0).abs() < 1.5, "{loud:?} {quiet:?}");
        assert!(loud.compressor.ratio >= 2.0 && loud.compressor.threshold_db < 0.0);
    }

    #[test]
    fn the_planned_gain_reaches_the_target_loudness() {
        let samples = voice(&Voice::default());
        let p = plan(&analyze(&samples, FS)).clone();
        let fs = f64::from(FS);
        let env = envelope_db(&samples, fs);
        let c = p.compressor;
        let gain = c.output_gain_db + p.gain_db;
        let out: Vec<f64> = k_weighted(&samples, fs)
            .iter()
            .zip(&env)
            .map(|(y, e)| {
                let r = if *e > c.threshold_db { (c.threshold_db - e) * (1.0 - 1.0 / c.ratio) } else { 0.0 };
                y * 10f64.powf((r + gain) / 20.0)
            })
            .collect();
        let lufs = integrated_loudness(&out, FS).unwrap();
        assert!((lufs - TARGET_LUFS).abs() < 0.5, "{lufs}");
    }

    #[test]
    fn silence_is_reported_and_not_tuned() {
        let a = analyze(&vec![0.0; FS as usize * 10], FS);
        assert!(a.plan.is_none());
        assert!(a.issues.iter().any(|i| i.kind == IssueKind::Silent && i.blocking));
    }

    #[test]
    fn a_very_quiet_mic_is_reported() {
        let a = analyze(&voice(&Voice { level: 0.002, noise: 0.000_002, ..Voice::default() }), FS);
        assert!(a.plan.is_none());
        assert!(a.issues.iter().any(|i| i.kind == IssueKind::TooQuiet), "{:?}", a.issues);
    }

    #[test]
    fn clipping_is_reported_and_not_tuned() {
        let a = analyze(&voice(&Voice { level: 3.0, ..Voice::default() }).iter().map(|s| s.clamp(-1.0, 1.0)).collect::<Vec<_>>(), FS);
        assert!(a.plan.is_none());
        assert!(a.issues.iter().any(|i| i.kind == IssueKind::Clipping));
    }

    #[test]
    fn heavy_background_noise_is_reported_and_not_tuned() {
        let a = analyze(&voice(&Voice { noise: 0.05, ..Voice::default() }), FS);
        assert!(a.plan.is_none(), "{:?} speech {:?} noise {:?}", a.issues, a.speech_dbfs, a.noise_dbfs);
        assert!(a.issues.iter().any(|i| i.kind == IssueKind::TooNoisy));
    }

    #[test]
    fn some_background_noise_adds_noise_suppression() {
        let a = analyze(&voice(&Voice { noise: 0.006, ..Voice::default() }), FS);
        assert!(plan(&a).noise_suppression, "{:?} speech {:?} noise {:?}", a.issues, a.speech_dbfs, a.noise_dbfs);
    }

    #[test]
    fn too_little_talking_is_reported() {
        let a = analyze(&voice(&Voice { seconds: 3.0, ..Voice::default() }), FS);
        assert!(a.issues.iter().any(|i| i.kind == IssueKind::TooShort && i.blocking));
    }
}
