//! Band-limited, mipmapped wavetables.
//!
//! A table has `frames` single-cycle frames (the morph axis) and mip levels. Level k keeps harmonics
//! 1..H_k (H_k = base_harmonics / 2^k) at size_k = max(min_size, next_pow2(2 * oversample * H_k))
//! samples per frame. A voice with phase increment `inc` (cycles/sample) uses the first level with
//! H_k * inc <= 0.5, so no harmonic ever exceeds Nyquist. Levels are inverse FFTs of the truncated
//! spectrum, DC removed, each frame peak-normalised on level 0 (same gain on all its levels).
//! Everything here allocates and runs at load time only, never in the audio path.

use core::f64::consts::PI;

const TWO_PI: f64 = 2.0 * PI;

pub struct Level {
    pub harmonics: usize,
    pub size: usize,
    pub data: Vec<f32>,
}

pub struct Table {
    pub frames: usize,
    pub levels: Vec<Level>,
}

#[derive(Clone, Copy, Debug)]
pub struct TableCfg {
    pub frames: usize,
    pub base_harmonics: usize,
    pub oversample: usize,
    pub min_size: usize,
    pub max_frames: usize,
}

pub fn next_pow2(n: usize) -> usize {
    let mut p = 1usize;
    while p < n {
        p <<= 1;
    }
    p
}

pub fn is_pow2(n: usize) -> bool {
    n > 0 && (n & (n - 1)) == 0
}

/// In-place iterative radix-2 complex FFT (unscaled inverse when `inverse`).
pub fn fft(re: &mut [f64], im: &mut [f64], inverse: bool) {
    let n = re.len();
    if n < 2 || !is_pow2(n) || im.len() != n {
        return;
    }
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let sign = if inverse { 1.0 } else { -1.0 };
    // twiddle table computed directly (no accumulated recurrence error)
    let half_n = n / 2;
    let mut tw_re = vec![0.0f64; half_n];
    let mut tw_im = vec![0.0f64; half_n];
    for k in 0..half_n {
        let (s, c) = (sign * TWO_PI * k as f64 / n as f64).sin_cos();
        tw_re[k] = c;
        tw_im[k] = s;
    }
    let mut len = 2usize;
    while len <= n {
        let half = len / 2;
        let step = n / len;
        let mut i = 0usize;
        while i < n {
            for k in 0..half {
                let wr = tw_re[k * step];
                let wi = tw_im[k * step];
                let a = i + k;
                let b = a + half;
                let xr = re[b] * wr - im[b] * wi;
                let xi = re[b] * wi + im[b] * wr;
                re[b] = re[a] - xr;
                im[b] = im[a] - xi;
                re[a] += xr;
                im[a] += xi;
            }
            i += len;
        }
        len <<= 1;
    }
}

/// Harmonic coefficients: x[n] = sum_h c[h] cos(2 pi h n / M) + s[h] sin(2 pi h n / M), h = 1..H.
#[derive(Clone)]
pub struct Spectrum {
    pub c: Vec<f64>,
    pub s: Vec<f64>,
}

impl Spectrum {
    pub fn new(h: usize) -> Spectrum {
        Spectrum { c: vec![0.0; h + 1], s: vec![0.0; h + 1] }
    }
    pub fn top(&self) -> usize {
        self.c.len().saturating_sub(1)
    }
}

/// Analyze one period (power-of-two length). DC is dropped.
pub fn analyze(samples: &[f32], max_h: usize) -> Spectrum {
    let m = samples.len();
    let mut sp = Spectrum::new(max_h);
    if m < 4 || !is_pow2(m) {
        return sp;
    }
    let mut re: Vec<f64> = samples.iter().map(|&x| x as f64).collect();
    let mut im = vec![0.0f64; m];
    fft(&mut re, &mut im, false);
    let h_top = max_h.min(m / 2 - 1);
    for h in 1..=h_top {
        sp.c[h] = 2.0 * re[h] / m as f64;
        sp.s[h] = -2.0 * im[h] / m as f64;
    }
    sp
}

/// One period of n samples keeping harmonics 1..h.
pub fn synthesize(sp: &Spectrum, n: usize, h: usize) -> Vec<f32> {
    let mut re = vec![0.0f64; n];
    let mut im = vec![0.0f64; n];
    if n >= 4 {
        let top = h.min(sp.top()).min(n / 2 - 1);
        let half = n as f64 / 2.0;
        for k in 1..=top {
            re[k] = half * sp.c[k];
            im[k] = -half * sp.s[k];
            re[n - k] = re[k];
            im[n - k] = -im[k];
        }
        fft(&mut re, &mut im, true);
    }
    re.iter().map(|&x| (x / n as f64) as f32).collect()
}

/// Mip plan: (harmonics, size) from the most harmonics down to 1.
pub fn mip_plan(cfg: &TableCfg, max_h: usize) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut h = max_h.max(1);
    let os = cfg.oversample.max(1);
    loop {
        out.push((h, next_pow2(cfg.min_size.max(4)).max(next_pow2(2 * os * h))));
        if h == 1 {
            break;
        }
        h = (h / 2).max(1);
    }
    out
}

pub fn table_from_spectra(spectra: &[Spectrum], cfg: &TableCfg) -> Option<Table> {
    if spectra.is_empty() {
        return None;
    }
    let mut max_h = cfg.base_harmonics.max(1);
    for sp in spectra {
        max_h = max_h.min(sp.top().max(1));
    }
    let plan = mip_plan(cfg, max_h);
    let frames = spectra.len();
    let mut levels: Vec<Level> =
        plan.iter().map(|&(h, size)| Level { harmonics: h, size, data: vec![0.0f32; frames * size] }).collect();
    for (f, sp) in spectra.iter().enumerate() {
        let top = synthesize(sp, plan[0].1, plan[0].0);
        let mut peak = 0.0f32;
        for &x in &top {
            peak = peak.max(x.abs());
        }
        let gain = if peak > 1e-9 { 1.0 / peak } else { 0.0 };
        for (k, lv) in levels.iter_mut().enumerate() {
            let d = if k == 0 { top.clone() } else { synthesize(sp, lv.size, lv.harmonics) };
            let off = f * lv.size;
            for i in 0..lv.size {
                lv.data[off + i] = d[i] * gain;
            }
        }
    }
    Some(Table { frames, levels })
}

pub fn table_from_frames(frames: &[Vec<f32>], cfg: &TableCfg) -> Option<Table> {
    let spectra: Vec<Spectrum> = frames
        .iter()
        .map(|fr| analyze(fr, cfg.base_harmonics.min((fr.len() / 2).saturating_sub(1)).max(1)))
        .collect();
    table_from_spectra(&spectra, cfg)
}

/// Mip level for phase increment `inc`; None if even the fundamental is above Nyquist.
#[inline]
pub fn mip_level_index(t: &Table, inc: f64) -> Option<usize> {
    for (k, lv) in t.levels.iter().enumerate() {
        if lv.harmonics as f64 * inc <= 0.5 {
            return Some(k);
        }
    }
    None
}

/// Slice mono samples into frames of `frame_size` (power of two) and build a table.
pub fn table_from_samples(samples: &[f32], frame_size: usize, cfg: &TableCfg) -> Option<Table> {
    if frame_size < 4 || !is_pow2(frame_size) {
        return None;
    }
    let count = (samples.len() / frame_size).min(cfg.max_frames.max(1));
    if count == 0 {
        return None;
    }
    let frames: Vec<Vec<f32>> = (0..count).map(|f| samples[f * frame_size..(f + 1) * frame_size].to_vec()).collect();
    table_from_frames(&frames, cfg)
}

// ------------------------------------------------------------------ factory tables

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

fn frac_of(f: usize, frames: usize) -> f64 {
    if frames > 1 {
        f as f64 / (frames - 1) as f64
    } else {
        0.0
    }
}

fn shape_spectrum(kind: u32, h_max: usize) -> Spectrum {
    let mut sp = Spectrum::new(h_max);
    for h in 1..=h_max {
        let hf = h as f64;
        match kind {
            0 => {
                if h == 1 {
                    sp.s[1] = 1.0;
                }
            }
            1 => {
                if h % 2 == 1 {
                    let sign = if ((h - 1) / 2) % 2 == 1 { -1.0 } else { 1.0 };
                    sp.s[h] = sign * 8.0 / (PI * PI * hf * hf);
                }
            }
            2 => {
                let sign = if h % 2 == 1 { 1.0 } else { -1.0 };
                sp.s[h] = (2.0 / PI) * sign / hf;
            }
            _ => {
                if h % 2 == 1 {
                    sp.s[h] = 4.0 / (PI * hf);
                }
            }
        }
    }
    sp
}

fn morph_spectra(keys: &[Spectrum], frames: usize) -> Vec<Spectrum> {
    let h_max = keys[0].top();
    let mut out = Vec::with_capacity(frames);
    let segs = keys.len().saturating_sub(1).max(1);
    for f in 0..frames {
        let x = frac_of(f, frames) * segs as f64;
        let i = (x.floor() as usize).min(segs - 1).min(keys.len().saturating_sub(2));
        let t = x - i as f64;
        let j = (i + 1).min(keys.len() - 1);
        let mut sp = Spectrum::new(h_max);
        for h in 1..=h_max {
            sp.c[h] = lerp(keys[i].c[h], keys[j].c[h], t);
            sp.s[h] = lerp(keys[i].s[h], keys[j].s[h], t);
        }
        out.push(sp);
    }
    out
}

fn pulse_spectrum(w: f64, h_max: usize) -> Spectrum {
    let mut sp = Spectrum::new(h_max);
    for h in 1..=h_max {
        let hf = h as f64;
        let a = (2.0 / (PI * hf)) * (PI * hf * w).sin();
        sp.c[h] = a * (PI * hf * w).cos();
        sp.s[h] = a * (PI * hf * w).sin();
    }
    sp
}

const VOWELS: [[(f64, f64); 3]; 5] = [
    [(800.0, 80.0), (1150.0, 90.0), (2900.0, 120.0)],
    [(400.0, 60.0), (1600.0, 80.0), (2700.0, 120.0)],
    [(350.0, 50.0), (2300.0, 90.0), (3000.0, 100.0)],
    [(450.0, 70.0), (800.0, 80.0), (2830.0, 100.0)],
    [(325.0, 50.0), (700.0, 60.0), (2530.0, 170.0)],
];
const VOWEL_F0: f64 = 110.0;

fn formant_spectrum(formants: &[(f64, f64); 3], h_max: usize) -> Spectrum {
    let mut sp = Spectrum::new(h_max);
    for h in 1..=h_max {
        let f = h as f64 * VOWEL_F0;
        let mut a = 0.0;
        for (i, &(fc, bw)) in formants.iter().enumerate() {
            let z = (f - fc) / bw;
            a += (-0.5 * z * z).exp() / (i as f64 + 1.0);
        }
        let sign = if h % 2 == 1 { 1.0 } else { -1.0 };
        sp.s[h] = (a + 0.02 / h as f64) * sign;
    }
    sp
}

fn time_frames(frames: usize, size: usize, f: &dyn Fn(f64, f64) -> f64) -> Vec<Vec<f32>> {
    (0..frames)
        .map(|k| {
            let t = frac_of(k, frames);
            (0..size).map(|i| f(i as f64 / size as f64, t) as f32).collect()
        })
        .collect()
}

pub const FACTORY_TABLE_NAMES: [&str; 7] = ["Basic Shapes", "PWM", "Vocal", "Harmonic Sweep", "Digital", "Hard Sync", "Organ"];

/// The factory tables, generated procedurally, in FACTORY_TABLE_NAMES order.
pub fn factory_tables(cfg: &TableCfg) -> Vec<Table> {
    let frames = cfg.frames.max(1);
    let h = cfg.base_harmonics.max(1);
    let size = mip_plan(cfg, h)[0].1;
    let mut out: Vec<Option<Table>> = Vec::new();

    let keys: Vec<Spectrum> = (0..4).map(|k| shape_spectrum(k, h)).collect();
    out.push(table_from_spectra(&morph_spectra(&keys, frames), cfg));

    let pwm: Vec<Spectrum> = (0..frames).map(|f| pulse_spectrum(lerp(0.5, 0.02, frac_of(f, frames)), h)).collect();
    out.push(table_from_spectra(&pwm, cfg));

    let vowels: Vec<Spectrum> = VOWELS.iter().map(|v| formant_spectrum(v, h)).collect();
    out.push(table_from_spectra(&morph_spectra(&vowels, frames), cfg));

    let sweep: Vec<Spectrum> = (0..frames)
        .map(|f| {
            let centre = 1.0 + frac_of(f, frames) * (h.min(48) as f64);
            let mut sp = Spectrum::new(h);
            for k in 1..=h {
                let z = (k as f64 - centre) / 2.5;
                sp.s[k] = 0.35 / k as f64 + (-0.5 * z * z).exp();
            }
            sp
        })
        .collect();
    out.push(table_from_spectra(&sweep, cfg));

    let digital = time_frames(frames, size, &|x, t| {
        let bits = lerp(8.0, 1.5, t).round().max(1.0);
        let steps = lerp(size as f64, 8.0, t * t).round().max(1.0);
        let xq = (x * steps).floor() / steps;
        let v = 0.5 * (TWO_PI * xq).sin() + 0.5 * (2.0 * xq - 1.0);
        let q = 2f64.powf(bits - 1.0);
        (v * q).round() / q
    });
    out.push(table_from_frames(&digital, cfg));

    let sync = time_frames(frames, size, &|x, t| {
        let ratio = lerp(1.0, 8.0, t);
        let p = (x * ratio).fract();
        2.0 * p - 1.0
    });
    out.push(table_from_frames(&sync, cfg));

    let bars = [1usize, 2, 3, 4, 6, 8, 10, 12, 16];
    let regs: [[f64; 9]; 4] = [
        [0.0, 8.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        [8.0, 8.0, 8.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        [8.0; 9],
        [8.0, 0.0, 0.0, 0.0, 0.0, 0.0, 8.0, 8.0, 8.0],
    ];
    let organ_keys: Vec<Spectrum> = regs
        .iter()
        .map(|r| {
            let mut sp = Spectrum::new(h);
            for (i, lvl) in r.iter().enumerate() {
                if bars[i] <= h {
                    sp.s[bars[i]] += lvl / 8.0;
                }
            }
            sp
        })
        .collect();
    out.push(table_from_spectra(&morph_spectra(&organ_keys, frames), cfg));

    out.into_iter().flatten().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> TableCfg {
        TableCfg { frames: 16, base_harmonics: 128, oversample: 4, min_size: 64, max_frames: 64 }
    }

    #[test]
    fn fft_roundtrip() {
        let n = 64;
        let mut re: Vec<f64> = (0..n).map(|i| ((i * 7) % 13) as f64 - 6.0).collect();
        let orig = re.clone();
        let mut im = vec![0.0; n];
        fft(&mut re, &mut im, false);
        fft(&mut re, &mut im, true);
        for i in 0..n {
            assert!((re[i] / n as f64 - orig[i]).abs() < 1e-9);
        }
    }

    #[test]
    fn factory_tables_are_band_limited_per_mip_level() {
        let c = cfg();
        let tables = factory_tables(&c);
        assert_eq!(tables.len(), FACTORY_TABLE_NAMES.len());
        for (ti, t) in tables.iter().enumerate() {
            assert_eq!(t.frames, c.frames);
            for lv in &t.levels {
                assert!(is_pow2(lv.size));
                assert!(lv.size >= 2 * c.oversample * lv.harmonics || lv.size >= c.min_size);
                for f in [0usize, t.frames / 2, t.frames - 1] {
                    let frame = &lv.data[f * lv.size..(f + 1) * lv.size];
                    let mut re: Vec<f64> = frame.iter().map(|&x| x as f64).collect();
                    let mut im = vec![0.0; lv.size];
                    fft(&mut re, &mut im, false);
                    let mag = |k: usize| (re[k] * re[k] + im[k] * im[k]).sqrt() * 2.0 / lv.size as f64;
                    let mut peak = 0.0f64;
                    for k in 1..=lv.harmonics.min(lv.size / 2 - 1) {
                        peak = peak.max(mag(k));
                    }
                    assert!(mag(0) < 1e-5, "table {} DC", ti);
                    for k in (lv.harmonics + 1)..=(lv.size / 2) {
                        assert!(mag(k) < 1e-5 * peak.max(1e-3), "table {} level h={} bin {} leaks {}", ti, lv.harmonics, k, mag(k));
                    }
                    let fmax = frame.iter().fold(0.0f32, |m, &x| m.max(x.abs()));
                    assert!(fmax <= 1.0 + 1e-3 || lv.harmonics < t.levels[0].harmonics, "level 0 normalised");
                }
            }
        }
    }

    #[test]
    fn mip_selection_never_exceeds_nyquist() {
        let c = cfg();
        let t = &factory_tables(&c)[0];
        let sr = 48000.0;
        let mut f = 8.0;
        while f < 23000.0 {
            let inc = f / sr;
            let k = mip_level_index(t, inc).expect("level below nyquist");
            assert!(t.levels[k].harmonics as f64 * f <= sr / 2.0);
            if k > 0 {
                assert!(t.levels[k - 1].harmonics as f64 * f > sr / 2.0, "uses the richest legal level");
            }
            f *= 1.07;
        }
        assert!(mip_level_index(t, 0.6).is_none());
    }

    #[test]
    fn samples_to_table() {
        let c = cfg();
        let fs = 256;
        let samples: Vec<f32> = (0..fs * 5).map(|i| ((i % fs) as f32 / fs as f32) * 2.0 - 1.0 + 0.3).collect();
        let t = table_from_samples(&samples, fs, &c).expect("table");
        assert_eq!(t.frames, 5);
        assert!(t.levels[0].harmonics <= fs / 2 - 1);
        assert!(table_from_samples(&samples, 300, &c).is_none());
        assert!(table_from_samples(&samples[..100], fs, &c).is_none());
        // DC (+0.3) was removed
        let lv = &t.levels[0];
        let mean: f32 = lv.data[..lv.size].iter().sum::<f32>() / lv.size as f32;
        assert!(mean.abs() < 1e-4);
    }
}
