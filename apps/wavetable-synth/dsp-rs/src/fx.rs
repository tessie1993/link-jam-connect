//! Stereo effects: chorus, Link-synced delay, FDN reverb, master gain + lookahead limiter.
//! Buffers are allocated in `new` only; `process` never allocates.

use crate::cfg::{Cfg, REVERB_DIFFUSERS, REVERB_LINES};
use crate::wavetable::next_pow2;

const TWO_PI: f32 = core::f32::consts::PI * 2.0;

/// Dry/wet with both at full level in the middle.
#[inline]
pub fn dry_gain(mix: f32) -> f32 {
    (2.0 * (1.0 - mix)).min(1.0).max(0.0)
}
#[inline]
pub fn wet_gain(mix: f32) -> f32 {
    (2.0 * mix).min(1.0).max(0.0)
}

#[inline]
fn flush(x: f32) -> f32 {
    if x.abs() < 1e-20 {
        0.0
    } else {
        x
    }
}

#[inline]
fn read_frac(buf: &[f32], mask: usize, w: usize, delay: f32) -> f32 {
    let pos = w as f32 - delay;
    let i = pos.floor();
    let f = pos - i;
    let i = i as i64;
    let a = buf[(i as usize) & mask];
    let b = buf[((i + 1) as usize) & mask];
    a + (b - a) * f
}

pub struct Chorus {
    sr: f32,
    base_ms: f32,
    depth_ms: f32,
    l: Vec<f32>,
    r: Vec<f32>,
    mask: usize,
    w: usize,
    phase: f32,
}

impl Chorus {
    pub fn new(sr: f32, c: &Cfg) -> Chorus {
        let len = next_pow2((((c.chorus_base_ms + c.chorus_depth_ms) / 1000.0) * sr).ceil() as usize + 4);
        Chorus { sr, base_ms: c.chorus_base_ms, depth_ms: c.chorus_depth_ms, l: vec![0.0; len], r: vec![0.0; len], mask: len - 1, w: len, phase: 0.0 }
    }
    pub fn reset(&mut self) {
        self.l.iter_mut().for_each(|x| *x = 0.0);
        self.r.iter_mut().for_each(|x| *x = 0.0);
    }
    pub fn process(&mut self, out_l: &mut [f32], out_r: &mut [f32], rate: f32, depth: f32, mix: f32) {
        let base = self.base_ms / 1000.0 * self.sr;
        let span = self.depth_ms / 1000.0 * self.sr * depth.max(0.0).min(1.0);
        let inc = rate / self.sr;
        let (dg, wg) = (dry_gain(mix), wet_gain(mix));
        let mask = self.mask;
        for i in 0..out_l.len().min(out_r.len()) {
            self.l[self.w & mask] = out_l[i];
            self.r[self.w & mask] = out_r[i];
            let dl = base + span * (0.5 + 0.5 * (TWO_PI * self.phase).sin());
            let dr = base + span * (0.5 + 0.5 * (TWO_PI * (self.phase + 0.25)).sin());
            let wl = read_frac(&self.l, mask, self.w, dl);
            let wr = read_frac(&self.r, mask, self.w, dr);
            out_l[i] = out_l[i] * dg + wl * wg;
            out_r[i] = out_r[i] * dg + wr * wg;
            self.w = self.w.wrapping_add(1);
            self.phase += inc;
            if self.phase >= 1.0 {
                self.phase -= 1.0;
            }
        }
    }
}

pub struct Delay {
    sr: f32,
    l: Vec<f32>,
    r: Vec<f32>,
    mask: usize,
    max_delay: f32,
    w: usize,
    cur: f32,
    smooth: f32,
    lp_l: f32,
    lp_r: f32,
}

impl Delay {
    pub fn new(sr: f32, c: &Cfg) -> Delay {
        let len = next_pow2((c.delay_max_sec * sr).ceil() as usize + 4);
        let smooth = 1.0 - (-1.0 / (c.delay_smooth_ms / 1000.0 * sr).max(1.0)).exp();
        Delay { sr, l: vec![0.0; len], r: vec![0.0; len], mask: len - 1, max_delay: (len - 4) as f32, w: len, cur: -1.0, smooth, lp_l: 0.0, lp_r: 0.0 }
    }
    pub fn reset(&mut self) {
        self.l.iter_mut().for_each(|x| *x = 0.0);
        self.r.iter_mut().for_each(|x| *x = 0.0);
        self.lp_l = 0.0;
        self.lp_r = 0.0;
        self.cur = -1.0;
    }
    #[allow(clippy::too_many_arguments)]
    pub fn process(&mut self, out_l: &mut [f32], out_r: &mut [f32], time_sec: f32, feedback: f32, mix: f32, pingpong: bool, tone_hz: f32) {
        let target = (time_sec * self.sr).max(1.0).min(self.max_delay);
        if self.cur < 0.0 {
            self.cur = target;
        }
        let lpc = 1.0 - (-TWO_PI * tone_hz.min(self.sr * 0.45).max(1.0) / self.sr).exp();
        let fb = feedback.max(0.0).min(0.999);
        let (dg, wg) = (dry_gain(mix), wet_gain(mix));
        let mask = self.mask;
        for i in 0..out_l.len().min(out_r.len()) {
            self.cur += (target - self.cur) * self.smooth;
            let ol = read_frac(&self.l, mask, self.w, self.cur);
            let or = read_frac(&self.r, mask, self.w, self.cur);
            self.lp_l += (ol - self.lp_l) * lpc;
            self.lp_r += (or - self.lp_r) * lpc;
            let (xl, xr) = (out_l[i], out_r[i]);
            if pingpong {
                self.l[self.w & mask] = 0.5 * (xl + xr) + self.lp_r * fb;
                self.r[self.w & mask] = self.lp_l * fb;
            } else {
                self.l[self.w & mask] = xl + self.lp_l * fb;
                self.r[self.w & mask] = xr + self.lp_r * fb;
            }
            out_l[i] = xl * dg + self.lp_l * wg;
            out_r[i] = xr * dg + self.lp_r * wg;
            self.w = self.w.wrapping_add(1);
        }
        self.lp_l = flush(self.lp_l);
        self.lp_r = flush(self.lp_r);
    }
}

struct Line {
    buf: Vec<f32>,
    w: usize,
    lp: f32,
}

/// 8-line feedback delay network (Householder mixing) with input allpass diffusion.
pub struct Reverb {
    sr: f32,
    lines: Vec<Line>,
    diff: Vec<Line>,
    min_decay: f32,
    max_decay: f32,
    damp_max: f32,
    diffusion: f32,
    gains: [f32; REVERB_LINES],
    out: [f32; REVERB_LINES],
    last_size: f32,
}

impl Reverb {
    pub fn new(sr: f32, c: &Cfg) -> Reverb {
        let mk = |ms: f32| Line { buf: vec![0.0; ((ms / 1000.0 * sr).round() as usize).max(2)], w: 0, lp: 0.0 };
        let lines: Vec<Line> = c.reverb_delays_ms.iter().map(|&ms| mk(ms)).collect();
        let diff: Vec<Line> = c.reverb_diffusers_ms.iter().map(|&ms| mk(ms)).collect();
        debug_assert_eq!(diff.len(), REVERB_DIFFUSERS);
        Reverb {
            sr,
            lines,
            diff,
            min_decay: c.reverb_min_decay,
            max_decay: c.reverb_max_decay.max(c.reverb_min_decay),
            damp_max: c.reverb_damp_max,
            diffusion: c.reverb_diffusion,
            gains: [0.0; REVERB_LINES],
            out: [0.0; REVERB_LINES],
            last_size: -1.0,
        }
    }
    pub fn reset(&mut self) {
        for l in self.lines.iter_mut().chain(self.diff.iter_mut()) {
            l.buf.iter_mut().for_each(|x| *x = 0.0);
            l.lp = 0.0;
        }
    }
    pub fn process(&mut self, out_l: &mut [f32], out_r: &mut [f32], size: f32, damp: f32, mix: f32) {
        if size != self.last_size {
            self.last_size = size;
            let rt60 = self.min_decay + size.max(0.0).min(1.0) * (self.max_decay - self.min_decay);
            for k in 0..REVERB_LINES {
                let n = self.lines[k].buf.len() as f32;
                self.gains[k] = 10f32.powf(-3.0 * n / (self.sr * rt60));
            }
        }
        let damp_c = 1.0 - damp.max(0.0).min(1.0) * self.damp_max;
        let ap = self.diffusion;
        let (dg, wg) = (dry_gain(mix), wet_gain(mix));
        let norm = 2.0 / REVERB_LINES as f32;
        let out_scale = 1.0 / ((REVERB_LINES / 2) as f32).sqrt();
        for i in 0..out_l.len().min(out_r.len()) {
            let mut x = 0.5 * (out_l[i] + out_r[i]);
            for d in self.diff.iter_mut() {
                let y = d.buf[d.w];
                let v = x + ap * y;
                d.buf[d.w] = v;
                x = y - ap * v;
                d.w += 1;
                if d.w >= d.buf.len() {
                    d.w = 0;
                }
            }
            let mut sum = 0.0;
            for k in 0..REVERB_LINES {
                let l = &mut self.lines[k];
                l.lp += (l.buf[l.w] - l.lp) * damp_c;
                self.out[k] = l.lp * self.gains[k];
                sum += self.out[k];
            }
            sum *= norm;
            let (mut wl, mut wr) = (0.0f32, 0.0f32);
            for k in 0..REVERB_LINES {
                let o = self.out[k];
                let l = &mut self.lines[k];
                l.buf[l.w] = o - sum + x;
                l.w += 1;
                if l.w >= l.buf.len() {
                    l.w = 0;
                }
                if k & 1 == 1 {
                    wr += o;
                } else {
                    wl += o;
                }
            }
            out_l[i] = out_l[i] * dg + wl * out_scale * wg;
            out_r[i] = out_r[i] * dg + wr * out_scale * wg;
        }
        for l in self.lines.iter_mut() {
            l.lp = flush(l.lp);
        }
    }
}

/// Master gain (smoothed) + lookahead peak limiter, hard-clamped at the ceiling.
pub struct Master {
    l: Vec<f32>,
    r: Vec<f32>,
    mask: usize,
    look: usize,
    w: usize,
    env: f32,
    gain: f32,
    g: f32,
    rel: f32,
    att: f32,
    g_smooth: f32,
    pub reduction: f32,
}

impl Master {
    pub fn new(sr: f32, c: &Cfg) -> Master {
        let look = ((c.limiter_lookahead_ms / 1000.0 * sr).round() as usize).max(1);
        let len = next_pow2(look + 2);
        Master {
            l: vec![0.0; len],
            r: vec![0.0; len],
            mask: len - 1,
            look,
            w: len,
            env: 0.0,
            gain: 1.0,
            g: -1.0,
            rel: (-1.0 / (c.limiter_release_ms / 1000.0 * sr).max(1.0)).exp(),
            att: 1.0 - (-3.0 / look as f32).exp(),
            g_smooth: 1.0 - (-1.0 / (c.gain_smooth_ms / 1000.0 * sr).max(1.0)).exp(),
            reduction: 1.0,
        }
    }
    pub fn process(&mut self, out_l: &mut [f32], out_r: &mut [f32], gain_lin: f32, limit: bool, ceiling: f32) {
        if self.g < 0.0 {
            self.g = gain_lin;
        }
        let ceil = ceiling.max(1e-6);
        let mask = self.mask;
        let mut min_gain = 1.0f32;
        for i in 0..out_l.len().min(out_r.len()) {
            self.g += (gain_lin - self.g) * self.g_smooth;
            let mut l = out_l[i] * self.g;
            let mut r = out_r[i] * self.g;
            if limit {
                self.l[self.w & mask] = l;
                self.r[self.w & mask] = r;
                let peak = l.abs().max(r.abs());
                self.env = peak.max(self.env * self.rel);
                let target = if self.env > ceil { ceil / self.env } else { 1.0 };
                let coef = if target < self.gain { self.att } else { 1.0 - self.rel };
                self.gain += (target - self.gain) * coef;
                let rd = self.w.wrapping_sub(self.look) & mask;
                l = (self.l[rd] * self.gain).max(-ceil).min(ceil);
                r = (self.r[rd] * self.gain).max(-ceil).min(ceil);
                self.w = self.w.wrapping_add(1);
                min_gain = min_gain.min(self.gain);
            }
            // non-finite input never reaches the output
            out_l[i] = if l.is_finite() { flush(l) } else { 0.0 };
            out_r[i] = if r.is_finite() { flush(r) } else { 0.0 };
        }
        self.env = flush(self.env);
        self.reduction = min_gain;
    }
}
