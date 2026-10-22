//! Level and loudness measurements for 48 kHz interleaved stereo float audio.

use serde::Serialize;

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: usize = 2;

/// A sample at or above this magnitude counts as clipped.
const CLIP_LEVEL: f32 = 0.999;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub duration_sec: f64,
    /// `None` when the recording is silent.
    pub peak_dbfs: Option<f64>,
    pub rms_dbfs: Option<f64>,
    /// Integrated loudness per ITU-R BS.1770 (LUFS); `None` when everything is below the -70 LUFS gate.
    pub loudness_lufs: Option<f64>,
    pub clipped_samples: usize,
}

fn to_db(linear: f64) -> Option<f64> {
    (linear > 0.0).then(|| 20.0 * linear.log10())
}

pub fn summarize(samples: &[f32]) -> Summary {
    let mut peak = 0f32;
    let mut sum_sq = 0f64;
    let mut clipped = 0;
    for &s in samples {
        let a = s.abs();
        peak = peak.max(a);
        sum_sq += f64::from(s) * f64::from(s);
        if a >= CLIP_LEVEL {
            clipped += 1;
        }
    }
    let rms = if samples.is_empty() { 0.0 } else { (sum_sq / samples.len() as f64).sqrt() };

    Summary {
        duration_sec: (samples.len() / CHANNELS) as f64 / f64::from(SAMPLE_RATE),
        peak_dbfs: to_db(f64::from(peak)),
        rms_dbfs: to_db(rms),
        loudness_lufs: integrated_loudness(samples),
        clipped_samples: clipped,
    }
}

/// Direct-form I biquad.
struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
    x: [f64; 2],
    y: [f64; 2],
}

impl Biquad {
    fn new(b: [f64; 3], a: [f64; 2]) -> Self {
        Self { b, a, x: [0.0; 2], y: [0.0; 2] }
    }

    fn process(&mut self, x0: f64) -> f64 {
        let y0 = self.b[0] * x0 + self.b[1] * self.x[0] + self.b[2] * self.x[1]
            - self.a[0] * self.y[0]
            - self.a[1] * self.y[1];
        self.x = [x0, self.x[0]];
        self.y = [y0, self.y[0]];
        y0
    }
}

/// BS.1770 K-weighting filter coefficients at 48 kHz.
fn k_weighting() -> (Biquad, Biquad) {
    (
        Biquad::new(
            [1.535_124_859_586_97, -2.691_696_189_406_38, 1.198_392_810_852_85],
            [-1.690_659_293_182_41, 0.732_480_774_215_85],
        ),
        Biquad::new([1.0, -2.0, 1.0], [-1.990_047_454_833_98, 0.990_072_250_366_21]),
    )
}

fn block_loudness(mean_square: f64) -> f64 {
    -0.691 + 10.0 * mean_square.log10()
}

fn integrated_loudness(samples: &[f32]) -> Option<f64> {
    let frames = samples.len() / CHANNELS;
    let step = SAMPLE_RATE as usize / 10; // 100 ms
    let block = step * 4; // 400 ms blocks, 75% overlap
    if frames < block {
        return None;
    }

    // Per 100 ms step: sum over channels of the K-weighted energy.
    let mut filters: Vec<(Biquad, Biquad)> = (0..CHANNELS).map(|_| k_weighting()).collect();
    let mut step_energy = vec![0f64; frames / step];
    for (i, frame) in samples.chunks_exact(CHANNELS).take(step_energy.len() * step).enumerate() {
        for (ch, &s) in frame.iter().enumerate() {
            let (shelf, highpass) = &mut filters[ch];
            let y = highpass.process(shelf.process(f64::from(s)));
            step_energy[i / step] += y * y;
        }
    }

    let blocks: Vec<f64> = step_energy
        .windows(4)
        .map(|w| w.iter().sum::<f64>() / block as f64)
        .collect();

    let gated_mean = |threshold: f64| {
        let kept: Vec<f64> = blocks.iter().copied().filter(|&z| block_loudness(z) > threshold).collect();
        (!kept.is_empty()).then(|| kept.iter().sum::<f64>() / kept.len() as f64)
    };

    let absolute = gated_mean(-70.0)?;
    let relative = gated_mean(block_loudness(absolute) - 10.0)?;
    Some(block_loudness(relative))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f64, amplitude: f32, seconds: f64) -> Vec<f32> {
        let frames = (seconds * f64::from(SAMPLE_RATE)) as usize;
        (0..frames)
            .flat_map(|i| {
                let v = amplitude * (2.0 * std::f64::consts::PI * freq * i as f64 / f64::from(SAMPLE_RATE)).sin() as f32;
                [v, v]
            })
            .collect()
    }

    #[test]
    fn silence_has_no_levels() {
        let s = summarize(&vec![0.0; 48_000 * 2 * 2]);
        assert_eq!(s.peak_dbfs, None);
        assert_eq!(s.loudness_lufs, None);
        assert_eq!(s.duration_sec, 2.0);
    }

    #[test]
    fn full_scale_sine_peak_is_zero_dbfs() {
        let s = summarize(&sine(1000.0, 1.0, 1.0));
        assert!(s.peak_dbfs.unwrap().abs() < 0.01);
        assert!((s.rms_dbfs.unwrap() + 3.01).abs() < 0.05);
    }

    // BS.1770 reference: a 0 dBFS 1 kHz sine in both channels reads about -0.0 LUFS
    // (each channel alone is -3.01 LUFS).
    #[test]
    fn stereo_1khz_sine_loudness_matches_reference() {
        let lufs = summarize(&sine(1000.0, 1.0, 3.0)).loudness_lufs.unwrap();
        assert!(lufs.abs() < 0.2, "got {lufs}");
    }

    #[test]
    fn minus_20_db_sine_is_20_lu_quieter() {
        let lufs = summarize(&sine(1000.0, 0.1, 3.0)).loudness_lufs.unwrap();
        assert!((lufs + 20.0).abs() < 0.2, "got {lufs}");
    }
}
