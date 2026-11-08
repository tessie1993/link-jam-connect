//! Modulation engine state: sources, routes, the tick, curve rendering and decimation.
//! All buffers are allocated in Core::new(); the tick path never allocates.
//!
//! Parameter / output / reference indexes per source type are part of the ABI and mirrored in
//! apps/mod-device/schema.js (checked at load with core_type_* exports and in the tests).

use crate::dsp::*;

pub const MAX_PARAMS: usize = 24;
pub const MAX_OUTS: usize = 12;
pub const MAX_REFS: usize = 3;
pub const MAX_DATA: usize = 256;
pub const MAX_SELF: usize = 8;

pub const T_NONE: u32 = 0;
pub const T_PAD: u32 = 1;
pub const T_MOTION: u32 = 2;
pub const T_LFO: u32 = 3;
pub const T_ENV: u32 = 4;
pub const T_SEQ: u32 = 5;
pub const T_EUCLID: u32 = 6;
pub const T_LORENZ: u32 = 7;
pub const T_LOGISTIC: u32 = 8;
pub const T_WALK: u32 = 9;
pub const T_PERLIN: u32 = 10;
pub const T_SH: u32 = 11;
pub const T_MIC: u32 = 12;
pub const T_BALL: u32 = 13;
pub const T_WELL: u32 = 14;
pub const T_MIDI: u32 = 15;
pub const T_MACRO: u32 = 16;
pub const TYPE_COUNT: u32 = 17;

// config keys (order mirrored in schema.js CONFIG_KEYS)
pub const C_PHYS_STEP: usize = 0;
pub const C_PHYS_MAX_SUB: usize = 1;
pub const C_REST_VEL: usize = 2;
pub const C_REST_DIST: usize = 3;
pub const C_TOL: usize = 4;
pub const C_RENDER_STEP: usize = 5;
pub const C_LOOKAHEAD: usize = 6;
pub const C_EXP: usize = 7;
pub const C_STALE: usize = 8;
pub const C_DCUT: usize = 9;
pub const C_SHAKE_THR: usize = 10;
pub const C_SHAKE_REFR: usize = 11;
pub const C_SHAKE_GATE: usize = 12;
pub const C_GRAV_LP: usize = 13;
pub const C_MAX_FINGERS: usize = 14;
pub const C_SWIPE_VEL: usize = 15;
pub const C_SWIPE_DIST: usize = 16;
pub const C_SWIPE_GATE: usize = 17;
pub const C_PINCH: usize = 18;
pub const C_ROT: usize = 19;
pub const C_VEL_RANGE: usize = 20;
pub const C_RADIUS: usize = 21;
pub const C_FORCE: usize = 22;
pub const C_THROW_IDLE: usize = 23;
pub const C_VF_MIN: usize = 24;
pub const C_VF_BETA: usize = 25;
pub const C_VF_DCUT: usize = 26;
pub const C_SEQ_GATE: usize = 27;
pub const C_LZ_SIGMA: usize = 28;
pub const C_LZ_RHO: usize = 29;
pub const C_LZ_BETA: usize = 30;
pub const C_LZ_DT: usize = 31;
pub const C_LZ_STEP: usize = 32;
pub const C_LZ_X0: usize = 33;
pub const C_LZ_BX: usize = 36;
pub const C_LZ_BY: usize = 37;
pub const C_LZ_ZMIN: usize = 38;
pub const C_LZ_ZMAX: usize = 39;
pub const C_LOG_X0: usize = 40;
pub const C_LOG_MAX_IT: usize = 41;
pub const C_BALL_DROP: usize = 42;
pub const C_WELL_X0: usize = 43;
pub const C_WELL_Y0: usize = 44;
pub const C_WELL_VX0: usize = 45;
pub const C_WELL_VY0: usize = 46;
pub const CFG_COUNT: usize = 47;

pub fn type_param_count(ty: u32) -> usize {
    match ty {
        T_PAD => 9,
        T_MOTION => 6,
        T_LFO => 12,
        T_ENV => 18,
        T_SEQ => 4,
        T_EUCLID => 6,
        T_LORENZ => 1,
        T_LOGISTIC => 4,
        T_WALK => 3,
        T_PERLIN => 5,
        T_SH => 4,
        T_MIC => 3,
        T_BALL => 4,
        T_WELL => 5,
        T_MIDI => 3,
        T_MACRO => 7,
        _ => 0,
    }
}
pub fn type_output_count(ty: u32) -> usize {
    match ty {
        T_NONE => 0,
        T_PAD => 12,
        T_MOTION => 11,
        T_LORENZ => 3,
        T_WELL => 2,
        T_MIDI => 3,
        T_SEQ => 2,
        t if t < TYPE_COUNT => 1,
        _ => 0,
    }
}
pub fn type_ref_count(ty: u32) -> usize {
    match ty {
        T_LFO | T_ENV | T_BALL | T_WELL => 1,
        T_SH => 2,
        T_MACRO => 3,
        _ => 0,
    }
}
pub fn type_output_bipolar(ty: u32, out: usize) -> bool {
    match ty {
        T_PAD => (6..=9).contains(&out),
        T_MOTION => out <= 5 || (7..=9).contains(&out),
        T_LFO | T_LORENZ | T_WALK | T_PERLIN | T_SH => true,
        _ => false,
    }
}
fn type_rank(ty: u32) -> u32 {
    match ty {
        T_LFO | T_ENV | T_BALL | T_WELL => 1,
        T_SH => 2,
        T_MACRO => 3,
        _ => 0,
    }
}

#[derive(Clone, Copy)]
pub struct Ref {
    pub slot: i32,
    pub out: i32,
}
const NO_REF: Ref = Ref { slot: -1, out: 0 };

#[derive(Clone, Copy)]
pub struct Ctx {
    pub has: bool,
    pub beat: f64,
    pub prev_beat: f64,
    pub tempo: f64,
    pub quantum: f64,
    pub now: f64,
    pub dt: f64,
}
impl Ctx {
    fn idle() -> Ctx {
        Ctx { has: false, beat: f64::NAN, prev_beat: f64::NAN, tempo: 0.0, quantum: 1.0, now: 0.0, dt: 0.0 }
    }
    /// Local ms of a Link beat near now (tempo constant over the lookahead window).
    pub fn ms_at(&self, beat: f64) -> f64 {
        if self.has && self.tempo > 0.0 {
            self.now + (beat - self.beat) * 60000.0 / self.tempo
        } else {
            self.now
        }
    }
}

/// What a source sees of one of its references this tick.
#[derive(Clone, Copy)]
pub struct RefIn {
    pub valid: bool,
    pub value: f64,
    pub uni: f64,
    pub rise: bool,
    pub fall: bool,
    pub rise_beat: f64,
    pub x: f64,
    pub y: f64,
    pub gate: f64,
}
const NO_IN: RefIn = RefIn { valid: false, value: 0.0, uni: 0.0, rise: false, fall: false, rise_beat: f64::NAN, x: 0.0, y: 0.0, gate: 0.0 };

#[derive(Clone)]
pub struct Source {
    pub ty: u32,
    pub params: [f64; MAX_PARAMS],
    pub eff: [f64; MAX_PARAMS],
    pub defs: [ParamDef; MAX_PARAMS],
    pub remote_abs: [f64; MAX_PARAMS],
    pub remote_off: [f64; MAX_PARAMS],
    pub self_abs: [f64; MAX_PARAMS],
    pub self_off: [f64; MAX_PARAMS],
    pub refs: [Ref; MAX_REFS],
    pub data: [f64; MAX_DATA],
    pub data_len: usize,
    pub values: [f64; MAX_OUTS],
    pub prev: [f64; MAX_OUTS],
    // state (fields used depend on the type)
    pub trig_beat: f64,
    pub trig_ms: f64,
    pub on_t: f64,
    pub off_t: f64,
    pub start_level: f64,
    pub vel: f64,
    pub thr_on: bool,
    pub x: f64,
    pub prev_x: f64,
    pub step: f64,
    pub held: f64,
    pub cur: f64,
    pub acc_ms: f64,
    pub rng: Rng,
    pub level: f64,
    pub env_v: f64,
    pub last_input: f64,
    pub phys: PadPhysics,
    pub gest: Gesture,
    pub latched: bool,
    pub lz: [f64; 3],
    pub stepper: FixedStepper,
    pub well: [f64; 4],
    pub notes: [bool; 128],
    pub slew: f64,
    pub motion: Motion,
    pub shake_until: f64,
    pub pattern: [u8; MAX_STEPS],
    pub pat_len: usize,
    pub pat_key: (f64, f64),
}

impl Source {
    pub fn new() -> Source {
        Source {
            ty: T_NONE,
            params: [0.0; MAX_PARAMS],
            eff: [0.0; MAX_PARAMS],
            defs: [ParamDef::default(); MAX_PARAMS],
            remote_abs: [f64::NAN; MAX_PARAMS],
            remote_off: [0.0; MAX_PARAMS],
            self_abs: [f64::NAN; MAX_PARAMS],
            self_off: [0.0; MAX_PARAMS],
            refs: [NO_REF; MAX_REFS],
            data: [0.0; MAX_DATA],
            data_len: 0,
            values: [0.0; MAX_OUTS],
            prev: [0.0; MAX_OUTS],
            trig_beat: f64::NAN,
            trig_ms: f64::NAN,
            on_t: f64::NAN,
            off_t: f64::NAN,
            start_level: 0.0,
            vel: 1.0,
            thr_on: false,
            x: 0.0,
            prev_x: 0.0,
            step: f64::NAN,
            held: 0.0,
            cur: 0.0,
            acc_ms: 0.0,
            rng: Rng::new(1),
            level: 0.0,
            env_v: 0.0,
            last_input: f64::NEG_INFINITY,
            phys: PadPhysics::new(1.0, 0.0),
            gest: Gesture::new(),
            latched: false,
            lz: [0.0; 3],
            stepper: FixedStepper::new(1.0, 0.0),
            well: [0.5; 4],
            notes: [false; 128],
            slew: f64::NAN,
            motion: Motion::new(),
            shake_until: f64::NEG_INFINITY,
            pattern: [0; MAX_STEPS],
            pat_len: 0,
            pat_key: (f64::NAN, f64::NAN),
        }
    }

    fn e(&self, i: usize) -> f64 {
        self.eff[i]
    }
    fn ei(&self, i: usize) -> i64 {
        self.eff[i].round() as i64
    }

    /// (Re)initialise the type state from the current params and config.
    pub fn init_state(&mut self, cfg: &[f64; CFG_COUNT]) {
        let ty = self.ty;
        let params = self.params;
        let defs = self.defs;
        let refs = self.refs;
        let data = self.data;
        let data_len = self.data_len;
        *self = Source::new();
        self.ty = ty;
        self.params = params;
        self.eff = params;
        self.defs = defs;
        self.refs = refs;
        self.data = data;
        self.data_len = data_len;
        match ty {
            T_PAD => {
                self.phys = PadPhysics::new(cfg[C_PHYS_STEP], cfg[C_PHYS_MAX_SUB]);
                self.phys.x = params[2];
                self.phys.y = params[3];
                self.values[0] = params[2];
                self.values[1] = params[3];
            }
            T_BALL => {
                self.phys = PadPhysics::new(cfg[C_PHYS_STEP], cfg[C_PHYS_MAX_SUB]);
                self.phys.y = 0.0;
            }
            T_LORENZ => {
                self.lz = [cfg[C_LZ_X0], cfg[C_LZ_X0 + 1], cfg[C_LZ_X0 + 2]];
                self.stepper = FixedStepper::new(cfg[C_LZ_STEP], cfg[C_PHYS_MAX_SUB]);
            }
            T_LOGISTIC => {
                self.x = cfg[C_LOG_X0];
                self.prev_x = self.x;
            }
            T_WALK => {
                self.rng = Rng::new(params[2].max(0.0) as u32);
            }
            T_WELL => {
                self.well = [cfg[C_WELL_X0], cfg[C_WELL_Y0], cfg[C_WELL_VX0], cfg[C_WELL_VY0]];
                self.stepper = FixedStepper::new(cfg[C_PHYS_STEP], cfg[C_PHYS_MAX_SUB]);
            }
            _ => {}
        }
        self.prev = self.values;
    }

    pub fn apply_eff(&mut self) {
        let n = type_param_count(self.ty);
        for i in 0..n {
            let d = self.defs[i];
            let has = self.remote_abs[i].is_finite() || self.self_abs[i].is_finite() || self.remote_off[i] != 0.0 || self.self_off[i] != 0.0;
            if !has || d.max == d.min {
                self.eff[i] = self.params[i];
                continue;
            }
            let mut nv = if self.remote_abs[i].is_finite() {
                self.remote_abs[i]
            } else if self.self_abs[i].is_finite() {
                self.self_abs[i]
            } else {
                real_to_norm(&d, self.params[i])
            };
            nv += self.remote_off[i] + self.self_off[i];
            self.eff[i] = norm_to_real(&d, clamp01(nv));
        }
    }

    pub fn predictable(&self, out: usize) -> bool {
        match self.ty {
            T_LFO | T_SEQ | T_EUCLID | T_PERLIN => true,
            T_ENV => out == 0 && self.ei(9) == 3 && self.e(1) < 0.5,
            _ => false,
        }
    }

    pub fn active(&self, ctx: &Ctx, cfg: &[f64; CFG_COUNT]) -> bool {
        match self.ty {
            T_PAD => self.gest.n > 0 || self.latched || !self.phys.rest,
            T_MOTION | T_MIC => ctx.now - self.last_input < cfg[C_STALE],
            T_NONE => false,
            _ => true,
        }
    }

    // ---------------------------------------------------------------- LFO
    fn lfo_pos(&self, beat: f64, ms: f64, q: f64) -> f64 {
        let rt = self.ei(10);
        if self.e(1) < 0.5 {
            if !beat.is_finite() {
                return f64::NAN;
            }
            let mut anchor = 0.0;
            if rt == 1 {
                anchor = (beat / q).floor() * q;
            } else if rt == 2 && self.trig_beat.is_finite() {
                anchor = self.trig_beat;
            }
            let per = division_beats(self.e(2), self.e(3), q);
            if !(per > 0.0) {
                return f64::NAN;
            }
            return (beat - anchor) / per + self.e(5);
        }
        let a = if rt == 2 && self.trig_ms.is_finite() { self.trig_ms } else { 0.0 };
        (ms - a) / 1000.0 * self.e(4) + self.e(5)
    }
    fn lfo_fade(&self, beat: f64, ms: f64) -> f64 {
        if self.e(1) < 0.5 {
            let fb = self.e(8);
            if fb > 0.0 && self.trig_beat.is_finite() && beat.is_finite() {
                return clamp01((beat - self.trig_beat) / fb);
            }
            return 1.0;
        }
        let fm = self.e(9);
        if fm > 0.0 && self.trig_ms.is_finite() {
            clamp01((ms - self.trig_ms) / fm)
        } else {
            1.0
        }
    }
    fn lfo_value(&self, beat: f64, ms: f64, q: f64) -> f64 {
        let c = self.lfo_pos(beat, ms, q);
        if !c.is_finite() {
            return 0.0;
        }
        let pts = &self.data[..self.data_len - self.data_len % 2];
        lfo_shape(self.ei(0).max(0) as u32, c, self.e(11).max(0.0) as u32, self.e(6), pts) * self.e(7) * self.lfo_fade(beat, ms)
    }
    pub fn retrigger(&mut self, beat: f64, ms: f64) {
        self.trig_beat = beat;
        self.trig_ms = ms;
    }

    // ---------------------------------------------------------------- envelope
    fn env_stages(&self, out: &mut [Stage; MAX_STAGES]) -> (usize, i32) {
        let a = Stage { dur: self.e(2), level: 1.0, curve: self.ei(7).max(0) as u32 };
        let d = Stage { dur: self.e(4), level: clamp01(self.e(5)), curve: self.ei(8).max(0) as u32 };
        let r = Stage { dur: self.e(6), level: 0.0, curve: self.ei(8).max(0) as u32 };
        match self.ei(0) {
            1 => {
                out[0] = a;
                out[1] = Stage { dur: self.e(3), level: 1.0, curve: 0 };
                out[2] = d;
                out[3] = r;
                (4, 2)
            }
            2 => {
                if self.data_len < 1 {
                    return (0, -1);
                }
                let sus = self.data[0].round() as i32;
                let mut n = 0;
                let mut i = 1;
                while i + 2 < self.data_len && n < MAX_STAGES {
                    out[n] = Stage { dur: self.data[i].max(0.0), level: clamp01(self.data[i + 1]), curve: self.data[i + 2].round().max(0.0) as u32 };
                    n += 1;
                    i += 3;
                }
                (n, if sus >= 0 && (sus as usize) < n { sus } else { -1 })
            }
            _ => {
                out[0] = a;
                out[1] = d;
                out[2] = r;
                (3, 1)
            }
        }
    }
    fn env_t(&self, ctx: &Ctx) -> f64 {
        if self.e(1) >= 0.5 {
            ctx.now
        } else {
            ctx.beat
        }
    }
    fn env_level_at(&self, t: f64, k: f64) -> f64 {
        let mut st = [Stage::default(); MAX_STAGES];
        let (n, sus) = self.env_stages(&mut st);
        env_level(&st[..n], sus, self.on_t, self.off_t, self.start_level, t, k)
    }
    fn gate_on(&mut self, t: f64, vel: f64, k: f64) {
        if !t.is_finite() {
            return;
        }
        self.start_level = if self.on_t.is_finite() { self.env_level_at(t, k) } else { 0.0 };
        self.on_t = t;
        self.off_t = f64::NAN;
        self.vel = vel;
    }
    fn gate_off(&mut self, t: f64) {
        if self.on_t.is_finite() && self.off_t.is_nan() && t.is_finite() {
            self.off_t = t.max(self.on_t);
        }
    }
    fn env_beat_cycle(&self, beat: f64, k: f64) -> f64 {
        let every = self.e(10);
        if !(every > 0.0) || !beat.is_finite() {
            return 0.0;
        }
        let mut st = [Stage::default(); MAX_STAGES];
        let (n, sus) = self.env_stages(&mut st);
        let on = (beat / every).floor() * every;
        let gl = self.e(11);
        let prev_on = on - every;
        let start = env_level(&st[..n], sus, prev_on, prev_on + gl, 0.0, on, k);
        env_level(&st[..n], sus, on, on + gl, start, beat, k)
    }

    // ---------------------------------------------------------------- seq / euclid
    fn step_beats(&self, div_i: usize, mod_i: usize, q: f64) -> f64 {
        division_beats(self.e(div_i), self.e(mod_i), q)
    }
    fn seq_value(&self, out: usize, beat: f64, q: f64, gate_frac: f64) -> f64 {
        if !beat.is_finite() {
            return self.values[out];
        }
        let sb = self.step_beats(1, 2, q);
        if !(sb > 0.0) {
            return 0.0;
        }
        let n = (self.ei(0).max(1) as usize).min(self.data_len.max(1));
        let pos = beat / sb;
        let i = pos.floor();
        let f = pos - i;
        if out == 1 {
            return if f < gate_frac { 1.0 } else { 0.0 };
        }
        if self.data_len == 0 {
            return 0.0;
        }
        let ii = i as i64;
        let cur = clamp01(self.data[modi(ii, n as i64) as usize]);
        let prev = clamp01(self.data[modi(ii - 1, n as i64) as usize]);
        let g = self.e(3);
        if g > 0.0 && f < g {
            prev + (cur - prev) * ease(3, f / g, 0.0)
        } else {
            cur
        }
    }
    fn update_pattern(&mut self) {
        let key = (self.e(1).round(), self.e(0).round());
        if key != self.pat_key {
            self.pat_key = key;
            self.pat_len = bjorklund(key.0.max(0.0) as usize, key.1.max(0.0) as usize, &mut self.pattern);
        }
    }
    fn euclid_hit(&self, i: i64) -> bool {
        if self.pat_len == 0 {
            return false;
        }
        self.pattern[modi(i - self.ei(2), self.pat_len as i64) as usize] == 1
    }
    fn euclid_value(&self, beat: f64, q: f64) -> f64 {
        if !beat.is_finite() {
            return 0.0;
        }
        let sb = self.step_beats(3, 4, q);
        if !(sb > 0.0) {
            return 0.0;
        }
        let pos = beat / sb;
        let i = pos.floor();
        if self.euclid_hit(i as i64) && pos - i < self.e(5) {
            1.0
        } else {
            0.0
        }
    }
    /// Trigger beats in (b0, b1]: (count > 0, last beat). Only for seq "trig" and euclid "gate".
    pub fn triggers_between(&self, out: usize, b0: f64, b1: f64, q: f64) -> Option<(bool, f64)> {
        let (sb, euclid) = match (self.ty, out) {
            (T_SEQ, 1) => (self.step_beats(1, 2, q), false),
            (T_EUCLID, 0) => (self.step_beats(3, 4, q), true),
            _ => return None,
        };
        if !(sb > 0.0) || !(b1 > b0) {
            return Some((false, f64::NAN));
        }
        let first = (b0 / sb).floor() as i64 + 1;
        let last = (b1 / sb).floor() as i64;
        if last < first {
            return Some((false, f64::NAN));
        }
        if !euclid {
            return Some((true, last as f64 * sb));
        }
        let lim = (self.pat_len as i64).max(1);
        let mut k = last;
        while k >= first && last - k < lim {
            if self.euclid_hit(k) {
                return Some((true, k as f64 * sb));
            }
            k -= 1;
        }
        Some((false, f64::NAN))
    }

    /// Value of a predictable output at a Link beat / local ms.
    pub fn value_at(&self, out: usize, beat: f64, ms: f64, q: f64, cfg: &[f64; CFG_COUNT]) -> f64 {
        match self.ty {
            T_LFO => self.lfo_value(beat, ms, q),
            T_SEQ => self.seq_value(out, beat, q, cfg[C_SEQ_GATE]),
            T_EUCLID => self.euclid_value(beat, q),
            T_PERLIN => {
                let x = if self.e(0) < 0.5 {
                    if !beat.is_finite() {
                        return 0.0;
                    }
                    beat * self.e(1)
                } else {
                    ms / 1000.0 * self.e(2)
                };
                fractal_noise(x, self.e(3), self.e(4).max(0.0) as u32)
            }
            T_ENV if self.predictable(out) => self.env_beat_cycle(beat, cfg[C_EXP]) * self.e(17),
            _ => self.values[out.min(MAX_OUTS - 1)],
        }
    }

    // ---------------------------------------------------------------- input events
    pub fn on_midi(&mut self, kind: u32, num: i32, value: i32, ch: i32, ctx: &Ctx, cfg: &[f64; CFG_COUNT]) {
        match self.ty {
            T_ENV => {
                if self.ei(9) != 4 {
                    return;
                }
                let note = self.ei(14);
                let c = self.ei(15);
                if kind > 1 || (note >= 0 && num as i64 != note) || (c > 0 && ch as i64 != c) {
                    return;
                }
                let t = self.env_t(ctx);
                if kind == 0 && value > 0 {
                    let v = if self.e(16) >= 0.5 { clamp01(value as f64 / 127.0) } else { 1.0 };
                    self.gate_on(t, v, cfg[C_EXP]);
                } else {
                    self.gate_off(t);
                }
            }
            T_MIDI => {
                let c = self.ei(2);
                if c > 0 && ch as i64 != c {
                    return;
                }
                if self.e(0) < 0.5 {
                    if kind == 2 && num as i64 == self.ei(1) {
                        self.values[0] = clamp01(value as f64 / 127.0);
                    }
                    return;
                }
                if num < 0 || num > 127 || kind > 1 {
                    return;
                }
                if kind == 0 && value > 0 {
                    self.notes[num as usize] = true;
                    self.values[0] = clamp01(num as f64 / 127.0);
                    self.values[2] = clamp01(value as f64 / 127.0);
                } else {
                    self.notes[num as usize] = false;
                }
                self.values[1] = if self.notes.iter().any(|n| *n) { 1.0 } else { 0.0 };
            }
            _ => {}
        }
    }

    /// Manual trigger (button / drop / retrigger). input = current value of the S&H input.
    pub fn trigger(&mut self, on: bool, ctx: &Ctx, cfg: &[f64; CFG_COUNT], input: f64) {
        match self.ty {
            T_LFO => {
                if on {
                    self.retrigger(ctx.beat, ctx.now);
                }
            }
            T_ENV => {
                let t = self.env_t(ctx);
                let mode = self.ei(9);
                if on {
                    self.gate_on(t, 1.0, cfg[C_EXP]);
                    if mode != 5 && mode != 0 {
                        self.off_t = t + self.e(11);
                    }
                } else {
                    self.gate_off(t);
                }
            }
            T_SH => {
                if on {
                    self.held = input;
                }
            }
            T_BALL => {
                if on {
                    self.drop_ball(cfg);
                }
            }
            T_MOTION => {
                if on {
                    self.shake_until = ctx.now + cfg[C_SHAKE_GATE];
                    self.last_input = ctx.now;
                }
            }
            _ => {}
        }
    }
    fn drop_ball(&mut self, cfg: &[f64; CFG_COUNT]) {
        self.phys.x = 0.5;
        self.phys.y = cfg[C_BALL_DROP];
        self.phys.release(0.0, 0.0);
    }

    fn gcfg(cfg: &[f64; CFG_COUNT]) -> GestureCfg {
        GestureCfg {
            max_fingers: cfg[C_MAX_FINGERS].max(1.0) as usize,
            swipe_min_velocity: cfg[C_SWIPE_VEL],
            swipe_min_distance: cfg[C_SWIPE_DIST],
            pinch_range: cfg[C_PINCH],
            rotate_range_deg: cfg[C_ROT],
            throw_idle_ms: cfg[C_THROW_IDLE],
            vf_min_cutoff: cfg[C_VF_MIN],
            vf_beta: cfg[C_VF_BETA],
            vf_d_cutoff: cfg[C_VF_DCUT],
        }
    }
    /// Pointer event: phase 0 down, 1 move, 2 up / cancel.
    pub fn pointer(&mut self, phase: u32, id: i32, x: f64, y: f64, pressure: f64, radius: f64, t: f64, hold: bool, cfg: &[f64; CFG_COUNT]) {
        if self.ty != T_PAD {
            return;
        }
        let c = Source::gcfg(cfg);
        let (x, y) = (clamp01(x), clamp01(y));
        match phase {
            0 => {
                if self.gest.down(id, x, y, pressure, radius, t, &c) {
                    if let Some(p) = self.gest.primary_ptr() {
                        self.phys.hold(p.x, p.y, 0.0, 0.0);
                    }
                    self.latched = false;
                }
            }
            1 => {
                self.gest.moved(id, x, y, pressure, radius, t, &c);
                if let Some(p) = self.gest.primary_ptr() {
                    self.phys.hold(p.x, p.y, self.gest.vx, self.gest.vy);
                }
            }
            _ => {
                if let Some(r) = self.gest.up(id, t, &c) {
                    if !r.last {
                        if let Some(p) = self.gest.primary_ptr() {
                            self.phys.hold(p.x, p.y, 0.0, 0.0);
                        }
                    } else if hold {
                        self.latched = true;
                        self.phys.vx = 0.0;
                        self.phys.vy = 0.0;
                    } else {
                        self.phys.release(r.vx, r.vy);
                    }
                }
            }
        }
    }
    /// UI info: 0 = current step (seq / euclid, -1 none), 1 = pad state (0 idle, 1 touched, 2 latched).
    pub fn info(&self, what: u32, ctx: &Ctx) -> f64 {
        match (what, self.ty) {
            (0, T_SEQ) | (0, T_EUCLID) => {
                if !ctx.has {
                    return -1.0;
                }
                let sb = if self.ty == T_SEQ { self.step_beats(1, 2, ctx.quantum) } else { self.step_beats(3, 4, ctx.quantum) };
                if !(sb > 0.0) {
                    return -1.0;
                }
                let n = if self.ty == T_SEQ { self.ei(0).max(1) } else { (self.pat_len as i64).max(1) };
                modi((ctx.beat / sb).floor() as i64, n) as f64
            }
            (1, T_PAD) => {
                if self.latched {
                    2.0
                } else if self.gest.n > 0 {
                    1.0
                } else {
                    0.0
                }
            }
            _ => -1.0,
        }
    }
    pub fn unlatch(&mut self) {
        if self.latched {
            self.latched = false;
            self.phys.release(0.0, 0.0);
        }
    }
    fn mparams(&self, cfg: &[f64; CFG_COUNT]) -> MotionParams {
        MotionParams { tilt_range: self.e(0), accel_range: self.e(1), rot_range: self.e(2), dead_zone: self.e(3), min_cutoff: self.e(4), filter_beta: self.e(5), d_cutoff: cfg[C_DCUT] }
    }
    pub fn motion_orientation(&mut self, a: f64, b: f64, g: f64, t: f64, cfg: &[f64; CFG_COUNT]) {
        if self.ty != T_MOTION {
            return;
        }
        let p = self.mparams(cfg);
        let mut out = self.values;
        self.motion.orientation([a, b, g], t, &p, &mut out);
        self.values = out;
        self.last_input = t;
    }
    pub fn motion_accel(&mut self, lin: [f64; 3], with_g: [f64; 3], t: f64, cfg: &[f64; CFG_COUNT]) {
        if self.ty != T_MOTION {
            return;
        }
        let p = self.mparams(cfg);
        let mut out = self.values;
        if self.motion.accel(lin, with_g, t, &p, cfg[C_GRAV_LP], cfg[C_SHAKE_THR], cfg[C_SHAKE_REFR], &mut out) {
            self.shake_until = t + cfg[C_SHAKE_GATE];
        }
        self.values = out;
        self.last_input = t;
    }
    pub fn motion_rotation(&mut self, r: [f64; 3], t: f64, cfg: &[f64; CFG_COUNT]) {
        if self.ty != T_MOTION {
            return;
        }
        let p = self.mparams(cfg);
        let mut out = self.values;
        self.motion.rotation(r, t, &p, &mut out);
        self.values = out;
        self.last_input = t;
    }
    /// Envelope follower input: RMS of a block of audio samples.
    pub fn audio_block(&mut self, samples: &[f32], t: f64) {
        if self.ty != T_MIC || samples.is_empty() {
            return;
        }
        let mut sum = 0.0f64;
        for s in samples {
            let v = *s as f64;
            if v.is_finite() {
                sum += v * v;
            }
        }
        self.level = (sum / samples.len() as f64).sqrt();
        self.last_input = t;
    }

    // ---------------------------------------------------------------- evaluation
    pub fn evaluate(&mut self, ctx: &Ctx, cfg: &[f64; CFG_COUNT], ins: &[RefIn; MAX_REFS]) {
        let q = ctx.quantum;
        match self.ty {
            T_LFO => {
                if ins[0].valid && ins[0].rise {
                    let b = if ins[0].rise_beat.is_finite() { ins[0].rise_beat } else { ctx.beat };
                    self.retrigger(b, ctx.now);
                }
                let needs = self.e(8) > 0.0 || self.e(9) > 0.0;
                if needs && self.trig_ms.is_nan() {
                    self.retrigger(ctx.beat, ctx.now);
                }
                if needs && self.trig_beat.is_nan() && ctx.has {
                    self.trig_beat = ctx.beat;
                }
                self.values[0] = self.lfo_value(ctx.beat, ctx.now, q);
            }
            T_ENV => self.eval_env(ctx, cfg, ins),
            T_SEQ => {
                self.values[0] = self.seq_value(0, ctx.beat, q, cfg[C_SEQ_GATE]);
                self.values[1] = self.seq_value(1, ctx.beat, q, cfg[C_SEQ_GATE]);
            }
            T_EUCLID => {
                self.update_pattern();
                self.values[0] = self.euclid_value(ctx.beat, q);
            }
            T_LORENZ => {
                let n = self.stepper.steps(ctx.dt);
                let dt = cfg[C_LZ_DT] * self.e(0);
                for _ in 0..n {
                    self.lz = lorenz_step(self.lz, dt, cfg[C_LZ_SIGMA], cfg[C_LZ_RHO], cfg[C_LZ_BETA]);
                    if !(self.lz[0].is_finite() && self.lz[1].is_finite() && self.lz[2].is_finite()) {
                        self.lz = [cfg[C_LZ_X0], cfg[C_LZ_X0 + 1], cfg[C_LZ_X0 + 2]];
                    }
                }
                let bx = if cfg[C_LZ_BX] > 0.0 { cfg[C_LZ_BX] } else { 1.0 };
                let by = if cfg[C_LZ_BY] > 0.0 { cfg[C_LZ_BY] } else { 1.0 };
                let bz = if cfg[C_LZ_ZMAX] > cfg[C_LZ_ZMIN] { cfg[C_LZ_ZMAX] - cfg[C_LZ_ZMIN] } else { 1.0 };
                self.values[0] = clamp(self.lz[0] / bx, -1.0, 1.0);
                self.values[1] = clamp(self.lz[1] / by, -1.0, 1.0);
                self.values[2] = clamp((self.lz[2] - cfg[C_LZ_ZMIN]) / bz * 2.0 - 1.0, -1.0, 1.0);
            }
            T_LOGISTIC => {
                if !ctx.has {
                    self.values[0] = clamp01(self.x);
                    return;
                }
                let sb = self.step_beats(1, 2, q);
                if !(sb > 0.0) {
                    return;
                }
                let k = (ctx.beat / sb).floor();
                if self.step.is_nan() {
                    self.step = k;
                }
                let n = (k - self.step).max(0.0).min(cfg[C_LOG_MAX_IT].max(0.0)) as i64;
                for _ in 0..n {
                    let r = clamp(self.e(0), 0.0, 4.0);
                    self.prev_x = self.x;
                    let mut x = r * self.x * (1.0 - self.x);
                    if !(x > 0.0 && x < 1.0) {
                        x = 0.05 + 0.9 * hash01(self.step as i64, 17);
                    }
                    self.x = x;
                }
                self.step = k;
                let f = ctx.beat / sb - k;
                let g = self.e(3);
                self.values[0] = clamp01(if g > 0.0 && f < g { self.prev_x + (self.x - self.prev_x) * (f / g) } else { self.x });
            }
            T_WALK => {
                let rate = self.e(0);
                if rate > 0.0 {
                    let period = 1000.0 / rate;
                    self.acc_ms += ctx.dt;
                    let mut n = 0;
                    let max = cfg[C_PHYS_MAX_SUB].max(1.0) as i64;
                    while self.acc_ms >= period && n < max {
                        self.acc_ms -= period;
                        let mut x = self.x + self.e(1) * self.rng.gauss();
                        let mut guard = 0;
                        while (x > 1.0 || x < -1.0) && guard < 8 {
                            x = if x > 1.0 { 2.0 - x } else { -2.0 - x };
                            guard += 1;
                        }
                        self.x = clamp(x, -1.0, 1.0);
                        n += 1;
                    }
                    if n >= max {
                        self.acc_ms = 0.0;
                    }
                }
                self.values[0] = self.x;
            }
            T_PERLIN => {
                self.values[0] = self.value_at(0, ctx.beat, ctx.now, q, cfg);
            }
            T_SH => {
                let clk = self.ei(0);
                if clk == 0 && ctx.has {
                    let sb = self.step_beats(1, 2, q);
                    if sb > 0.0 {
                        let k = (ctx.beat / sb).floor();
                        if k != self.step {
                            self.step = k;
                            self.held = ins[0].value;
                        }
                    }
                } else if clk == 1 && ins[1].valid && ins[1].rise {
                    self.held = ins[0].value;
                }
                let g = self.e(3);
                if g > 0.0 {
                    let m = 2.0 * ctx.dt / g;
                    self.cur += clamp(self.held - self.cur, -m, m);
                } else {
                    self.cur = self.held;
                }
                self.values[0] = self.cur;
            }
            T_MIC => {
                let tau = if self.level > self.env_v { self.e(1) } else { self.e(2) };
                self.env_v += (self.level - self.env_v) * (1.0 - (-(ctx.dt.max(0.0)) / tau.max(1e-3)).exp());
                self.values[0] = clamp01(self.env_v * self.e(0));
            }
            T_BALL => {
                let tr = self.ei(2);
                if tr == 0 && ins[0].valid && ins[0].rise {
                    self.drop_ball(cfg);
                }
                if tr == 1 && ctx.has && ctx.prev_beat.is_finite() {
                    let every = self.e(3);
                    if every > 0.0 && (ctx.beat / every).floor() > (ctx.prev_beat / every).floor() {
                        self.drop_ball(cfg);
                    }
                }
                let p = PhysParams { mode: 4, home_x: 0.5, home_y: 0.0, spring_k: 0.0, damping: 0.0, friction: 0.0, restitution: self.e(1), gravity: self.e(0), rest_velocity: cfg[C_REST_VEL], rest_distance: cfg[C_REST_DIST] };
                self.phys.advance(ctx.dt, &p);
                self.values[0] = clamp01(self.phys.y);
            }
            T_WELL => {
                let (wx, wy) = if ins[0].valid && ins[0].gate >= 0.5 { (ins[0].x, ins[0].y) } else { (self.e(3), self.e(4)) };
                let n = self.stepper.steps(ctx.dt);
                let dt = self.stepper.dt();
                let (s, damp, soft) = (self.e(0), self.e(1), self.e(2));
                let w = &mut self.well;
                for _ in 0..n {
                    let dx = wx - w[0];
                    let dy = wy - w[1];
                    let r2 = dx * dx + dy * dy + soft * soft;
                    let inv = if r2 > 0.0 { s / (r2 * r2.sqrt()) } else { 0.0 };
                    w[2] += (dx * inv - damp * w[2]) * dt;
                    w[3] += (dy * inv - damp * w[3]) * dt;
                    w[0] += w[2] * dt;
                    w[1] += w[3] * dt;
                    if w[0] < 0.0 || w[0] > 1.0 {
                        w[0] = clamp01(w[0]);
                        w[2] = -w[2];
                    }
                    if w[1] < 0.0 || w[1] > 1.0 {
                        w[1] = clamp01(w[1]);
                        w[3] = -w[3];
                    }
                }
                self.values[0] = clamp01(self.well[0]);
                self.values[1] = clamp01(self.well[1]);
            }
            T_MACRO => {
                let a = if ins[0].valid { ins[0].uni } else { 0.0 };
                let b = if ins[1].valid { ins[1].uni } else { 0.0 };
                let amt = self.e(1);
                let v = match self.ei(0) {
                    0 => clamp01(a + b),
                    1 => clamp01(a - b),
                    2 => a * b,
                    3 => a.min(b),
                    4 => a.max(b),
                    5 => (a + b) / 2.0,
                    6 => {
                        let x = if ins[2].valid { ins[2].uni } else { clamp01(amt) };
                        a * (1.0 - x) + b * x
                    }
                    7 => {
                        let n = self.e(3).round().max(2.0) - 1.0;
                        (a * n).round() / n
                    }
                    8 => {
                        let ms = self.e(4);
                        if self.slew.is_nan() || !(ms > 0.0) {
                            self.slew = a;
                        } else {
                            let m = ctx.dt / ms;
                            self.slew += clamp(a - self.slew, -m, m);
                        }
                        self.slew
                    }
                    9 => ease(self.ei(5).max(0) as u32 + 1, a, self.e(6)),
                    10 => 1.0 - a,
                    11 => clamp01(a * amt + self.e(2)),
                    _ => a,
                };
                self.values[0] = clamp01(v);
            }
            T_PAD => {
                let p = PhysParams {
                    mode: self.ei(1).max(0) as u32,
                    home_x: self.e(2),
                    home_y: self.e(3),
                    spring_k: self.e(4),
                    damping: self.e(5),
                    friction: self.e(6),
                    restitution: self.e(7),
                    gravity: self.e(8),
                    rest_velocity: cfg[C_REST_VEL],
                    rest_distance: cfg[C_REST_DIST],
                };
                self.phys.advance(ctx.dt, &p);
                let layout = self.ei(0);
                self.values[0] = if layout == 2 { self.phys.y } else { self.phys.x };
                self.values[1] = if layout == 1 { self.phys.x } else { self.phys.y };
                let g = &self.gest;
                let pp = g.primary_ptr();
                self.values[11] = if g.n > 0 { 1.0 } else { 0.0 };
                self.values[2] = match pp {
                    Some(p) => clamp01(if p.pressure.is_finite() { p.pressure } else { cfg[C_FORCE] }),
                    None => 0.0,
                };
                self.values[3] = match pp {
                    Some(p) if cfg[C_RADIUS] > 0.0 => clamp01(p.radius / cfg[C_RADIUS]),
                    _ => 0.0,
                };
                let v = if pp.is_some() { g.vx.hypot(g.vy) } else { self.phys.vx.hypot(self.phys.vy) };
                self.values[4] = if cfg[C_VEL_RANGE] > 0.0 { clamp01(v / cfg[C_VEL_RANGE]) } else { 0.0 };
                self.values[5] = clamp01(g.n as f64 / cfg[C_MAX_FINGERS].max(1.0));
                self.values[6] = g.pinch;
                self.values[7] = g.rotate;
                self.values[8] = g.swipe_x;
                self.values[9] = g.swipe_y;
                self.values[10] = if ctx.now - g.swipe_at < cfg[C_SWIPE_GATE] { 1.0 } else { 0.0 };
            }
            T_MOTION => {
                self.values[10] = if ctx.now < self.shake_until { 1.0 } else { 0.0 };
            }
            _ => {}
        }
    }

    fn eval_env(&mut self, ctx: &Ctx, cfg: &[f64; CFG_COUNT], ins: &[RefIn; MAX_REFS]) {
        let mode = self.ei(9);
        let beats = self.e(1) < 0.5;
        let k = cfg[C_EXP];
        if beats && !ctx.has {
            self.values[0] = 0.0;
            return;
        }
        let t = self.env_t(ctx);
        if mode == 3 {
            if beats {
                self.values[0] = clamp01(self.env_beat_cycle(ctx.beat, k) * self.e(17));
                return;
            }
            if ctx.has && ctx.prev_beat.is_finite() {
                let every = self.e(10);
                if every > 0.0 {
                    let nb = (ctx.beat / every).floor() * every;
                    if nb > ctx.prev_beat {
                        let at = ctx.ms_at(nb);
                        self.gate_on(at, 1.0, k);
                        self.off_t = at + self.e(11);
                    }
                }
            }
        } else if (mode == 0 || mode == 1) && ins[0].valid {
            if ins[0].rise {
                let at = if beats && ins[0].rise_beat.is_finite() { ins[0].rise_beat } else { t };
                self.gate_on(at, 1.0, k);
                if mode == 1 {
                    self.off_t = at + self.e(11);
                }
            }
            if mode == 0 && ins[0].fall {
                self.gate_off(t);
            }
        } else if mode == 2 && ins[0].valid {
            let v = ins[0].uni;
            if !self.thr_on && v >= self.e(12) {
                self.thr_on = true;
                self.gate_on(t, 1.0, k);
            } else if self.thr_on && v < self.e(12) - self.e(13) {
                self.thr_on = false;
                self.gate_off(t);
            }
        }
        self.values[0] = clamp01(self.env_level_at(t, k) * self.vel * self.e(17));
    }
}

#[derive(Clone, Copy)]
pub struct SelfT {
    pub kind: u32,
    pub slot: u32,
    pub idx: u32,
}

pub struct Route {
    pub used: bool,
    pub enabled: bool,
    pub src: Ref,
    pub offset_mode: bool,
    pub curve_on: bool,
    pub tf: Tf,
    pub defs: [ParamDef; 2],
    pub remote_abs: [f64; 2],
    pub remote_off: [f64; 2],
    pub self_abs: [f64; 2],
    pub self_off: [f64; 2],
    pub eff: [f64; 2],
    pub state: f64,
    pub value: f64,
    pub input: f64,
    pub active: bool,
    pub predictable: bool,
    pub buf: Vec<Pt>,
    pub cap: usize,
    pub has_anchor: bool,
    pub cursor: f64,
    pub render_state: f64,
    pub render_last: f64,
    pub keep: Vec<u8>,
    pub stack: Vec<(usize, usize)>,
    pub selfs: [SelfT; MAX_SELF],
    pub nself: usize,
}

impl Route {
    pub fn new(cap: usize) -> Route {
        let cap = cap.max(4);
        Route {
            used: false,
            enabled: false,
            src: NO_REF,
            offset_mode: false,
            curve_on: false,
            tf: Tf::new(),
            defs: [ParamDef::default(); 2],
            remote_abs: [f64::NAN; 2],
            remote_off: [0.0; 2],
            self_abs: [f64::NAN; 2],
            self_off: [0.0; 2],
            eff: [1.0, 0.0],
            state: f64::NAN,
            value: 0.0,
            input: 0.0,
            active: false,
            predictable: false,
            buf: Vec::with_capacity(cap),
            cap,
            has_anchor: false,
            cursor: f64::NAN,
            render_state: f64::NAN,
            render_last: f64::NAN,
            keep: vec![0u8; cap],
            stack: vec![(0usize, 0usize); cap + 2],
            selfs: [SelfT { kind: 0, slot: 0, idx: 0 }; MAX_SELF],
            nself: 0,
        }
    }
    pub fn clear(&mut self) {
        let cap = self.cap;
        let buf = std::mem::take(&mut self.buf);
        let keep = std::mem::take(&mut self.keep);
        let stack = std::mem::take(&mut self.stack);
        *self = Route { buf, keep, stack, ..Route::new_empty(cap) };
        self.buf.clear();
    }
    fn new_empty(cap: usize) -> Route {
        Route {
            used: false,
            enabled: false,
            src: NO_REF,
            offset_mode: false,
            curve_on: false,
            tf: Tf::new(),
            defs: [ParamDef::default(); 2],
            remote_abs: [f64::NAN; 2],
            remote_off: [0.0; 2],
            self_abs: [f64::NAN; 2],
            self_off: [0.0; 2],
            eff: [1.0, 0.0],
            state: f64::NAN,
            value: 0.0,
            input: 0.0,
            active: false,
            predictable: false,
            buf: Vec::new(),
            cap,
            has_anchor: false,
            cursor: f64::NAN,
            render_state: f64::NAN,
            render_last: f64::NAN,
            keep: Vec::new(),
            stack: Vec::new(),
            selfs: [SelfT { kind: 0, slot: 0, idx: 0 }; MAX_SELF],
            nself: 0,
        }
    }
    /// Forget pending curve points (start / stop of modulation, timeline jump).
    pub fn reset_curve(&mut self) {
        self.buf.clear();
        self.has_anchor = false;
        self.cursor = f64::NAN;
        self.render_state = f64::NAN;
        self.render_last = f64::NAN;
    }
    /// Append a curve point; beats must increase, the buffer never grows past its capacity.
    pub fn push(&mut self, beat: f64, value: f64) -> bool {
        if !beat.is_finite() || !value.is_finite() {
            return false;
        }
        if let Some(last) = self.buf.last() {
            if !(beat > last.beat) {
                return false;
            }
        }
        if self.buf.len() >= self.cap {
            return false;
        }
        self.buf.push(Pt { beat, value });
        true
    }
    fn apply_eff(&mut self) {
        for i in 0..2 {
            let d = self.defs[i];
            let base = if i == 0 { self.tf.depth } else { self.tf.offset };
            let has = self.remote_abs[i].is_finite() || self.self_abs[i].is_finite() || self.remote_off[i] != 0.0 || self.self_off[i] != 0.0;
            if !has || d.max == d.min {
                self.eff[i] = base;
                continue;
            }
            let mut nv = if self.remote_abs[i].is_finite() {
                self.remote_abs[i]
            } else if self.self_abs[i].is_finite() {
                self.self_abs[i]
            } else {
                real_to_norm(&d, base)
            };
            nv += self.remote_off[i] + self.self_off[i];
            self.eff[i] = norm_to_real(&d, clamp01(nv));
        }
    }
    fn tf_eff(&self, global_depth: f64) -> Tf {
        let mut t = self.tf;
        t.depth = self.eff[0] * global_depth;
        t.offset = self.eff[1];
        t
    }
}

pub struct Core {
    pub cfg: [f64; CFG_COUNT],
    pub sources: Vec<Source>,
    pub routes: Vec<Route>,
    pub order: Vec<usize>,
    pub out: Vec<f64>,
    pub hold: bool,
    pub frozen: bool,
    pub last: Ctx,
    pub last_beat: f64,
    pub global: f64,
    pub gdef: ParamDef,
    pub g_remote_abs: f64,
    pub g_remote_off: f64,
    pub g_self_abs: f64,
    pub g_self_off: f64,
    pub g_eff: f64,
    pub seed: u32,
}

impl Core {
    pub fn new(seed: u32, max_sources: usize, max_routes: usize, buffer_points: usize, out_capacity: usize) -> Core {
        let mut sources = Vec::with_capacity(max_sources);
        for _ in 0..max_sources {
            sources.push(Source::new());
        }
        let mut routes = Vec::with_capacity(max_routes);
        for _ in 0..max_routes {
            routes.push(Route::new(buffer_points));
        }
        Core {
            cfg: [0.0; CFG_COUNT],
            sources,
            routes,
            order: Vec::with_capacity(max_sources),
            out: vec![0.0; out_capacity.max(2)],
            hold: false,
            frozen: false,
            last: Ctx::idle(),
            last_beat: f64::NAN,
            global: 1.0,
            gdef: ParamDef { min: 0.0, max: 1.0, exp: false, steps: 0.0 },
            g_remote_abs: f64::NAN,
            g_remote_off: 0.0,
            g_self_abs: f64::NAN,
            g_self_off: 0.0,
            g_eff: 1.0,
            seed,
        }
    }

    fn reorder(&mut self) {
        self.order.clear();
        for rank in 0..4 {
            for i in 0..self.sources.len() {
                let t = self.sources[i].ty;
                if t != T_NONE && type_rank(t) == rank {
                    self.order.push(i);
                }
            }
        }
    }

    pub fn source_create(&mut self, slot: usize, ty: u32) -> bool {
        if slot >= self.sources.len() || ty >= TYPE_COUNT {
            return false;
        }
        let mut s = Source::new();
        s.ty = ty;
        self.sources[slot] = s;
        self.reorder();
        true
    }
    pub fn source_remove(&mut self, slot: usize) {
        if slot < self.sources.len() {
            self.sources[slot] = Source::new();
            self.reorder();
        }
    }
    pub fn source_init(&mut self, slot: usize) {
        if slot < self.sources.len() {
            let cfg = self.cfg;
            self.sources[slot].init_state(&cfg);
        }
    }
    pub fn set_param(&mut self, slot: usize, idx: usize, v: f64) {
        if slot >= self.sources.len() || idx >= MAX_PARAMS || !v.is_finite() {
            return;
        }
        let s = &mut self.sources[slot];
        s.params[idx] = v;
        s.eff[idx] = v;
        if s.ty == T_WALK && idx == 2 {
            s.rng = Rng::new(v.max(0.0) as u32);
        }
    }
    pub fn set_ref(&mut self, slot: usize, k: usize, src: i32, out: i32) {
        if slot < self.sources.len() && k < MAX_REFS {
            self.sources[slot].refs[k] = Ref { slot: src, out };
        }
    }
    pub fn set_data(&mut self, slot: usize, data: &[f64]) {
        if slot < self.sources.len() {
            let s = &mut self.sources[slot];
            let n = data.len().min(MAX_DATA);
            s.data[..n].copy_from_slice(&data[..n]);
            s.data_len = n;
        }
    }

    pub fn polarity_bi(&self, slot: usize, out: usize) -> bool {
        let s = match self.sources.get(slot) {
            Some(s) => s,
            None => return false,
        };
        if s.ty == T_SH {
            let r = s.refs[0];
            if r.slot >= 0 && (r.slot as usize) < self.sources.len() {
                let t = self.sources[r.slot as usize].ty;
                return t == T_SH || type_output_bipolar(t, r.out.max(0) as usize);
            }
            return true;
        }
        type_output_bipolar(s.ty, out)
    }

    fn ref_valid(&self, r: Ref) -> Option<(usize, usize)> {
        if r.slot < 0 || r.out < 0 {
            return None;
        }
        let (s, o) = (r.slot as usize, r.out as usize);
        if s >= self.sources.len() || self.sources[s].ty == T_NONE || o >= type_output_count(self.sources[s].ty) {
            return None;
        }
        Some((s, o))
    }

    fn ref_input(&self, r: Ref, ctx: &Ctx) -> RefIn {
        let (s, o) = match self.ref_valid(r) {
            Some(x) => x,
            None => return NO_IN,
        };
        let src = &self.sources[s];
        let bi = self.polarity_bi(s, o);
        let uni = |v: f64| if bi { (clamp(v, -1.0, 1.0) + 1.0) / 2.0 } else { clamp01(v) };
        let cur = uni(src.values[o]);
        let prev = uni(src.prev[o]);
        let mut rin = RefIn { valid: true, value: src.values[o], uni: cur, rise: prev < 0.5 && cur >= 0.5, fall: prev >= 0.5 && cur < 0.5, rise_beat: f64::NAN, x: src.values[0], y: src.values[1], gate: if src.ty == T_PAD { src.values[11] } else { 0.0 } };
        if ctx.has && ctx.prev_beat.is_finite() && ctx.beat > ctx.prev_beat {
            if let Some((any, last)) = src.triggers_between(o, ctx.prev_beat, ctx.beat, ctx.quantum) {
                rin.rise = any;
                rin.rise_beat = last;
            }
        }
        rin
    }

    fn collect_self_mods(&mut self) {
        for s in self.sources.iter_mut() {
            for i in 0..MAX_PARAMS {
                s.self_abs[i] = f64::NAN;
                s.self_off[i] = 0.0;
            }
        }
        for r in self.routes.iter_mut() {
            r.self_abs = [f64::NAN; 2];
            r.self_off = [0.0; 2];
        }
        self.g_self_abs = f64::NAN;
        self.g_self_off = 0.0;
        for ri in 0..self.routes.len() {
            let (active, value, off, n) = {
                let r = &self.routes[ri];
                (r.used && r.active, r.value, r.offset_mode, r.nself)
            };
            if !active {
                continue;
            }
            for k in 0..n {
                let t = self.routes[ri].selfs[k];
                let idx = t.idx as usize;
                match t.kind {
                    0 => {
                        if let Some(s) = self.sources.get_mut(t.slot as usize) {
                            if idx < MAX_PARAMS {
                                if off {
                                    s.self_off[idx] += value;
                                } else {
                                    s.self_abs[idx] = value;
                                }
                            }
                        }
                    }
                    1 => {
                        if let Some(r) = self.routes.get_mut(t.slot as usize) {
                            if idx < 2 {
                                if off {
                                    r.self_off[idx] += value;
                                } else {
                                    r.self_abs[idx] = value;
                                }
                            }
                        }
                    }
                    _ => {
                        if off {
                            self.g_self_off += value;
                        } else {
                            self.g_self_abs = value;
                        }
                    }
                }
            }
        }
    }

    fn apply_global(&mut self) {
        let has = self.g_remote_abs.is_finite() || self.g_self_abs.is_finite() || self.g_remote_off != 0.0 || self.g_self_off != 0.0;
        if !has || self.gdef.max == self.gdef.min {
            self.g_eff = self.global;
            return;
        }
        let mut n = if self.g_remote_abs.is_finite() {
            self.g_remote_abs
        } else if self.g_self_abs.is_finite() {
            self.g_self_abs
        } else {
            real_to_norm(&self.gdef, self.global)
        };
        n += self.g_remote_off + self.g_self_off;
        self.g_eff = norm_to_real(&self.gdef, clamp01(n));
    }

    pub fn effective(&self, kind: u32, slot: usize, idx: usize) -> f64 {
        match kind {
            0 => self.sources.get(slot).map(|s| if idx < MAX_PARAMS { s.eff[idx] } else { f64::NAN }).unwrap_or(f64::NAN),
            1 => self.routes.get(slot).map(|r| if idx < 2 { r.eff[idx] } else { f64::NAN }).unwrap_or(f64::NAN),
            _ => self.g_eff,
        }
    }

    /// Rendered (or current) route value at a beat: pure, for curves ahead of time and Ableton peeks.
    fn route_render(&self, ri: usize, beat: f64, ms: f64, ctx: &Ctx, state: Option<&mut f64>, dt: f64) -> f64 {
        let r = &self.routes[ri];
        let (s, o) = match self.ref_valid(r.src) {
            Some(x) => x,
            None => return r.value,
        };
        let raw = self.sources[s].value_at(o, beat, ms, ctx.quantum, &self.cfg);
        apply_transform(raw, self.polarity_bi(s, o), r.offset_mode, &r.tf_eff(self.g_eff), state, dt)
    }

    pub fn route_peek(&self, ri: usize, beat: f64, ms: f64) -> f64 {
        let r = match self.routes.get(ri) {
            Some(r) => r,
            None => return f64::NAN,
        };
        if !r.used || !r.predictable || !self.last.has || r.tf.slew_ms > 0.0 || !beat.is_finite() {
            return r.value;
        }
        self.route_render(ri, beat, ms, &self.last, None, 0.0)
    }

    fn route_tick(&mut self, ri: usize, ctx: &Ctx, lead_ms: f64) {
        if !self.routes[ri].used {
            return;
        }
        let src = self.routes[ri].src;
        let valid = self.ref_valid(src);
        let (raw, bi, src_active, predictable) = match valid {
            Some((s, o)) => {
                let so = &self.sources[s];
                (so.values[o], self.polarity_bi(s, o), so.active(ctx, &self.cfg), so.predictable(o))
            }
            None => (0.0, false, false, false),
        };
        let g = self.g_eff;
        {
            let r = &mut self.routes[ri];
            if valid.is_some() {
                r.input = raw;
                let tf = r.tf_eff(g);
                let mut st = r.state;
                r.value = apply_transform(raw, bi, r.offset_mode, &tf, Some(&mut st), ctx.dt);
                r.state = st;
            }
            r.active = r.enabled && !self.frozen && valid.is_some() && src_active;
            r.predictable = predictable;
            if !r.active || !r.curve_on || !ctx.has || !(ctx.tempo > 0.0) {
                return;
            }
        }
        let bpm = ctx.tempo / 60000.0;
        let from = ctx.beat + lead_ms * bpm;
        if !predictable {
            let v = self.routes[ri].value;
            self.routes[ri].push(from, v);
            return;
        }
        let to = from + self.cfg[C_LOOKAHEAD].max(0.0) * bpm;
        let step = self.cfg[C_RENDER_STEP] * bpm;
        if !(step > 0.0) {
            return;
        }
        let mut cursor = self.routes[ri].cursor;
        if !cursor.is_finite() || cursor < from - step {
            cursor = from;
        }
        let mut st = self.routes[ri].render_state;
        let mut last = self.routes[ri].render_last;
        let mut guard = 0;
        while cursor <= to && guard < self.routes[ri].cap {
            let dt = if last.is_finite() { (cursor - last) / bpm } else { 0.0 };
            let v = self.route_render(ri, cursor, ctx.ms_at(cursor), ctx, Some(&mut st), dt);
            last = cursor;
            self.routes[ri].push(cursor, v);
            cursor += step;
            guard += 1;
        }
        let r = &mut self.routes[ri];
        r.cursor = cursor;
        r.render_state = st;
        r.render_last = last;
    }

    /// Decimate the pending points of a route into the output buffer as (beat, value) pairs.
    /// The last point stays as the anchor of the next batch. Returns the number of points.
    pub fn route_flush(&mut self, ri: usize) -> usize {
        let tol = self.cfg[C_TOL];
        let r = match self.routes.get_mut(ri) {
            Some(r) => r,
            None => return 0,
        };
        let n = r.buf.len();
        let first_new = if r.has_anchor { 1 } else { 0 };
        if n <= first_new {
            return 0;
        }
        if r.tf.steps >= 2.0 {
            decimate_steps(&r.buf, tol / 2.0, &mut r.keep);
        } else {
            decimate(&r.buf, tol, &mut r.keep, &mut r.stack);
        }
        let mut k = 0;
        let max = self.out.len() / 2;
        for i in first_new..n {
            if r.keep[i] == 1 && k < max {
                self.out[2 * k] = r.buf[i].beat;
                self.out[2 * k + 1] = r.buf[i].value;
                k += 1;
            }
        }
        let anchor = r.buf[n - 1];
        r.buf.clear();
        r.buf.push(anchor);
        r.has_anchor = true;
        k
    }

    pub fn set_hold(&mut self, on: bool) {
        self.hold = on;
        if !on {
            for s in self.sources.iter_mut() {
                if s.ty == T_PAD {
                    s.unlatch();
                }
            }
        }
    }

    pub fn trigger(&mut self, slot: usize, on: bool) {
        if slot >= self.sources.len() {
            return;
        }
        let ctx = self.last;
        let input = self.ref_input(self.sources[slot].refs[0], &ctx).value;
        let cfg = self.cfg;
        self.sources[slot].trigger(on, &ctx, &cfg, input);
    }

    pub fn midi(&mut self, kind: u32, num: i32, value: i32, ch: i32) {
        let ctx = self.last;
        let cfg = self.cfg;
        for s in self.sources.iter_mut() {
            if s.ty != T_NONE {
                s.on_midi(kind, num, value, ch, &ctx, &cfg);
            }
        }
    }

    /// One engine step. beat NaN = no Link timeline. lead_ms = how far ahead realtime points are stamped.
    /// Returns the number of active routes.
    pub fn tick(&mut self, beat: f64, tempo: f64, quantum: f64, now: f64, dt: f64, lead_ms: f64) -> u32 {
        let has = beat.is_finite() && tempo > 0.0;
        let mut prev = self.last_beat;
        if has && prev.is_finite() && beat < prev {
            prev = f64::NAN;
            for r in self.routes.iter_mut() {
                r.reset_curve();
            }
        }
        let ctx = Ctx {
            has,
            beat: if has { beat } else { f64::NAN },
            prev_beat: if has { prev } else { f64::NAN },
            tempo: if has { tempo } else { 0.0 },
            quantum: if quantum > 0.0 { quantum } else { 1.0 },
            now,
            dt: fin(dt, 0.0).max(0.0),
        };
        self.last = ctx;
        self.collect_self_mods();
        for s in self.sources.iter_mut() {
            if s.ty != T_NONE {
                s.apply_eff();
            }
        }
        for r in self.routes.iter_mut() {
            if r.used {
                r.apply_eff();
            }
        }
        self.apply_global();
        for oi in 0..self.order.len() {
            let i = self.order[oi];
            let refs = self.sources[i].refs;
            let mut ins = [NO_IN; MAX_REFS];
            for k in 0..type_ref_count(self.sources[i].ty).min(MAX_REFS) {
                ins[k] = self.ref_input(refs[k], &ctx);
            }
            let cfg = &self.cfg;
            self.sources[i].evaluate(&ctx, cfg, &ins);
        }
        let lead = fin(lead_ms, 0.0).max(0.0);
        let mut active = 0;
        for ri in 0..self.routes.len() {
            self.route_tick(ri, &ctx, lead);
            if self.routes[ri].used && self.routes[ri].active {
                active += 1;
            }
        }
        for oi in 0..self.order.len() {
            let i = self.order[oi];
            self.sources[i].prev = self.sources[i].values;
        }
        self.last_beat = if has { beat } else { f64::NAN };
        active
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> [f64; CFG_COUNT] {
        let mut c = [0.0; CFG_COUNT];
        c[C_PHYS_STEP] = 2.0;
        c[C_PHYS_MAX_SUB] = 200.0;
        c[C_REST_VEL] = 0.02;
        c[C_REST_DIST] = 0.002;
        c[C_TOL] = 0.004;
        c[C_RENDER_STEP] = 10.0;
        c[C_LOOKAHEAD] = 100.0;
        c[C_EXP] = 4.0;
        c[C_STALE] = 1000.0;
        c[C_DCUT] = 1.0;
        c[C_SHAKE_THR] = 14.0;
        c[C_SHAKE_REFR] = 350.0;
        c[C_SHAKE_GATE] = 120.0;
        c[C_GRAV_LP] = 0.8;
        c[C_MAX_FINGERS] = 5.0;
        c[C_SWIPE_VEL] = 1.5;
        c[C_SWIPE_DIST] = 0.15;
        c[C_SWIPE_GATE] = 150.0;
        c[C_PINCH] = 4.0;
        c[C_ROT] = 180.0;
        c[C_VEL_RANGE] = 4.0;
        c[C_RADIUS] = 60.0;
        c[C_FORCE] = 0.5;
        c[C_THROW_IDLE] = 60.0;
        c[C_VF_MIN] = 2.0;
        c[C_VF_BETA] = 0.1;
        c[C_VF_DCUT] = 1.0;
        c[C_SEQ_GATE] = 0.5;
        c[C_LZ_SIGMA] = 10.0;
        c[C_LZ_RHO] = 28.0;
        c[C_LZ_BETA] = 8.0 / 3.0;
        c[C_LZ_DT] = 0.01;
        c[C_LZ_STEP] = 5.0;
        c[C_LZ_X0] = 0.1;
        c[C_LZ_BX] = 25.0;
        c[C_LZ_BY] = 35.0;
        c[C_LZ_ZMIN] = 0.0;
        c[C_LZ_ZMAX] = 55.0;
        c[C_LOG_X0] = 0.4;
        c[C_LOG_MAX_IT] = 64.0;
        c[C_BALL_DROP] = 1.0;
        c[C_WELL_X0] = 0.5;
        c[C_WELL_Y0] = 0.85;
        c[C_WELL_VX0] = 0.6;
        c[C_WELL_VY0] = 0.0;
        c
    }
    fn core() -> Core {
        let mut c = Core::new(1, 16, 8, 512, 1024);
        c.cfg = cfg();
        c
    }
    /// Piecewise tempo timeline: (atMs, beat, tempo) segments.
    struct Tl {
        seg: Vec<(f64, f64, f64)>,
    }
    impl Tl {
        fn beat(&self, ms: f64) -> f64 {
            let mut s = self.seg[0];
            for x in &self.seg {
                if x.0 <= ms {
                    s = *x;
                }
            }
            s.1 + (ms - s.0) * s.2 / 60000.0
        }
        fn tempo(&self, ms: f64) -> f64 {
            let mut s = self.seg[0];
            for x in &self.seg {
                if x.0 <= ms {
                    s = *x;
                }
            }
            s.2
        }
    }
    fn lfo(c: &mut Core, slot: usize, shape: f64, sync: f64, bars: f64) {
        c.source_create(slot, T_LFO);
        let p = [shape, sync, bars, 0.0, 1.0, 0.0, 0.5, 1.0, 0.0, 0.0, 0.0, 1.0];
        for (i, v) in p.iter().enumerate() {
            c.set_param(slot, i, *v);
        }
        c.source_init(slot);
    }

    #[test]
    fn lfo_phase_lock_across_tempo_changes() {
        let mut a = core();
        let mut b = core();
        lfo(&mut a, 0, 0.0, 0.0, 0.25);
        lfo(&mut b, 3, 0.0, 0.0, 0.25);
        let mut tl = Tl { seg: vec![(0.0, 0.0, 120.5)] };
        let change = 1003.0;
        let bc = tl.beat(change);
        tl.seg.push((change, bc, 87.25));
        let off = 12345.678; // peer B has another local clock
        let mut t = 0.0;
        let mut prev = f64::NAN;
        while t <= 2500.0 {
            let beat = tl.beat(t);
            a.tick(beat, tl.tempo(t), 4.0, t, 7.0, 0.0);
            b.tick(beat, tl.tempo(t), 4.0, t + off, 7.0, 0.0);
            let va = a.sources[0].values[0];
            let vb = b.sources[3].values[0];
            assert!((va - vb).abs() < 1e-12);
            assert!((va - (2.0 * std::f64::consts::PI * frac(beat)).sin()).abs() < 1e-9);
            if prev.is_finite() {
                assert!((va - prev).abs() <= 2.0 * std::f64::consts::PI * 7.0 * 120.5 / 60000.0 + 1e-9, "no jump at the tempo change");
            }
            prev = va;
            t += 7.0;
        }
        // retrigger on bar
        a.set_param(0, 10, 1.0);
        a.set_param(0, 2, 1.0);
        a.tick(8.0 + 1e-9, 120.0, 4.0, 3000.0, 1.0, 0.0);
        assert!(a.sources[0].values[0].abs() < 1e-6);
        // free Hz
        a.set_param(0, 10, 0.0);
        a.set_param(0, 1, 1.0);
        a.set_param(0, 4, 2.0);
        a.tick(f64::NAN, 0.0, 4.0, 125.0, 1.0, 0.0);
        assert!((a.sources[0].values[0] - 1.0).abs() < 1e-9);
    }

    #[test]
    fn beat_envelope_and_gate() {
        let mut c = core();
        c.source_create(0, T_ENV);
        // adsr, beats, a1 h0 d1 s.5 r1, lin, lin, trigger beat every 4, gate 2
        let p = [0.0, 0.0, 1.0, 0.0, 1.0, 0.5, 1.0, 0.0, 0.0, 3.0, 4.0, 2.0, 0.5, 0.05, -1.0, 0.0, 0.0, 1.0];
        for (i, v) in p.iter().enumerate() {
            c.set_param(0, i, *v);
        }
        c.source_init(0);
        let s = &c.sources[0];
        assert!(s.predictable(0));
        assert!((s.value_at(0, 8.5, 0.0, 4.0, &c.cfg) - 0.5).abs() < 1e-12);
        assert!((s.value_at(0, 9.5, 0.0, 4.0, &c.cfg) - 0.75).abs() < 1e-12);
        assert!((s.value_at(0, 10.5, 0.0, 4.0, &c.cfg) - 0.25).abs() < 1e-12);
        // touch-gated envelope in ms
        c.source_create(1, T_PAD);
        for (i, v) in [0.0, 0.0, 0.5, 0.5, 80.0, 10.0, 1.5, 0.75, 6.0].iter().enumerate() {
            c.set_param(1, i, *v);
        }
        c.source_init(1);
        c.source_create(2, T_ENV);
        let p = [0.0, 1.0, 100.0, 0.0, 100.0, 0.5, 100.0, 0.0, 0.0, 0.0, 4.0, 250.0, 0.5, 0.05, -1.0, 0.0, 0.0, 1.0];
        for (i, v) in p.iter().enumerate() {
            c.set_param(2, i, *v);
        }
        c.source_init(2);
        c.set_ref(2, 0, 1, 11);
        let nan = f64::NAN;
        c.tick(nan, 0.0, 4.0, 0.0, 0.0, 0.0);
        let cf = c.cfg;
        c.sources[1].pointer(0, 1, 0.5, 0.5, nan, 10.0, 10.0, false, &cf);
        c.tick(nan, 0.0, 4.0, 10.0, 10.0, 0.0);
        c.tick(nan, 0.0, 4.0, 60.0, 50.0, 0.0);
        assert!((c.sources[2].values[0] - 0.5).abs() < 1e-9);
        c.tick(nan, 0.0, 4.0, 400.0, 340.0, 0.0);
        assert!((c.sources[2].values[0] - 0.5).abs() < 1e-9);
        c.sources[1].pointer(2, 1, 0.5, 0.5, nan, 10.0, 405.0, false, &cf);
        c.tick(nan, 0.0, 4.0, 410.0, 10.0, 0.0);
        c.tick(nan, 0.0, 4.0, 460.0, 50.0, 0.0);
        assert!((c.sources[2].values[0] - 0.25).abs() < 1e-9);
    }

    #[test]
    fn route_curve_render_and_decimate() {
        let mut c = core();
        lfo(&mut c, 0, 0.0, 0.0, 0.25);
        let r = &mut c.routes[0];
        r.used = true;
        r.enabled = true;
        r.curve_on = true;
        r.offset_mode = true;
        r.src = Ref { slot: 0, out: 0 };
        r.tf.depth = 0.5;
        r.defs = [ParamDef { min: -1.0, max: 1.0, exp: false, steps: 0.0 }, ParamDef { min: -1.0, max: 1.0, exp: false, steps: 0.0 }];
        let tempo = 120.0;
        let mut t = 0.0;
        let mut pts = Vec::new();
        while t < 400.0 {
            c.tick(t * tempo / 60000.0, tempo, 4.0, t, 10.0, 50.0);
            if (t as i64) % 40 == 0 {
                let n = c.route_flush(0);
                for k in 0..n {
                    pts.push((c.out[2 * k], c.out[2 * k + 1]));
                }
            }
            t += 10.0;
        }
        assert!(!pts.is_empty());
        for w in pts.windows(2) {
            assert!(w[1].0 > w[0].0);
        }
        for (b, v) in &pts {
            assert!((v - 0.5 * (2.0 * std::f64::consts::PI * frac(*b)).sin()).abs() < 1e-9);
        }
        let horizon = (400.0 + 50.0 + 100.0) * tempo / 60000.0;
        assert!(pts.last().unwrap().0 <= horizon + 1e-9);
        assert!(pts[0].0 >= 50.0 * tempo / 60000.0 - 1e-9);
        // decimated: far fewer points than rendered samples, error bounded by construction
        assert!(pts.len() < 60);
    }

    #[test]
    fn realtime_route_lead() {
        let mut c = core();
        c.source_create(0, T_PAD);
        for (i, v) in [0.0, 0.0, 0.5, 0.5, 80.0, 10.0, 1.5, 0.75, 6.0].iter().enumerate() {
            c.set_param(0, i, *v);
        }
        c.source_init(0);
        {
            let r = &mut c.routes[1];
            r.used = true;
            r.enabled = true;
            r.curve_on = true;
            r.src = Ref { slot: 0, out: 0 };
            r.defs = [ParamDef { min: -1.0, max: 1.0, exp: false, steps: 0.0 }, ParamDef { min: -1.0, max: 1.0, exp: false, steps: 0.0 }];
        }
        let cf = c.cfg;
        c.tick(0.0, 120.0, 4.0, 0.0, 0.0, 82.5);
        assert!(!c.routes[1].active);
        c.sources[0].pointer(0, 1, 0.3, 0.5, f64::NAN, 10.0, 0.0, false, &cf);
        c.tick(2.0, 120.0, 4.0, 1000.0, 10.0, 82.5);
        assert!(c.routes[1].active);
        assert_eq!(c.routes[1].buf.len(), 1);
        assert!((c.routes[1].buf[0].beat - (2.0 + 82.5 * 120.0 / 60000.0)).abs() < 1e-12);
        assert!((c.routes[1].buf[0].value - 0.3).abs() < 1e-12);
    }

    #[test]
    fn chaos_sources_bounded_and_euclid_triggers() {
        let mut c = core();
        c.source_create(0, T_LORENZ);
        c.set_param(0, 0, 10.0);
        c.source_init(0);
        c.source_create(1, T_LOGISTIC);
        for (i, v) in [4.0, 0.03125, 0.0, 0.0].iter().enumerate() {
            c.set_param(1, i, *v);
        }
        c.source_init(1);
        c.source_create(2, T_WALK);
        for (i, v) in [200.0, 0.5, 7.0].iter().enumerate() {
            c.set_param(2, i, *v);
        }
        c.source_init(2);
        c.source_create(3, T_WELL);
        for (i, v) in [5.0, 0.0, 0.08, 0.5, 0.5].iter().enumerate() {
            c.set_param(3, i, *v);
        }
        c.source_init(3);
        c.source_create(4, T_EUCLID);
        for (i, v) in [8.0, 3.0, 1.0, 0.125, 0.0, 0.5].iter().enumerate() {
            c.set_param(4, i, *v);
        }
        c.source_init(4);
        let mut t = 0.0;
        while t < 20000.0 {
            c.tick(t * 120.0 / 60000.0, 120.0, 4.0, t, 16.0, 0.0);
            for s in 0..4 {
                for o in 0..type_output_count(c.sources[s].ty) {
                    let v = c.sources[s].values[o];
                    assert!(v.is_finite());
                    let bi = c.polarity_bi(s, o);
                    assert!(if bi { (-1.0..=1.0).contains(&v) } else { (0.0..=1.0).contains(&v) });
                }
            }
            t += 16.0;
        }
        let tr = c.sources[4].triggers_between(0, -1e-9, 3.999, 4.0).unwrap();
        assert!(tr.0 && (tr.1 - 3.5).abs() < 1e-12);
        let tr2 = c.sources[4].triggers_between(0, 0.6, 1.9, 4.0).unwrap();
        assert!(!tr2.0);
    }

    #[test]
    fn self_modulation_and_remote() {
        let mut c = core();
        lfo(&mut c, 0, 2.0, 1.0, 1.0);
        c.sources[0].defs[5] = ParamDef { min: 0.0, max: 1.0, exp: false, steps: 0.0 };
        c.source_create(1, T_PAD);
        for (i, v) in [0.0, 0.0, 0.5, 0.5, 80.0, 10.0, 1.5, 0.75, 6.0].iter().enumerate() {
            c.set_param(1, i, *v);
        }
        c.source_init(1);
        {
            let r = &mut c.routes[0];
            r.used = true;
            r.enabled = true;
            r.src = Ref { slot: 1, out: 0 };
            r.defs = [ParamDef { min: -1.0, max: 1.0, exp: false, steps: 0.0 }, ParamDef { min: -1.0, max: 1.0, exp: false, steps: 0.0 }];
            r.selfs[0] = SelfT { kind: 0, slot: 0, idx: 5 };
            r.nself = 1;
        }
        let cf = c.cfg;
        c.sources[1].pointer(0, 1, 0.25, 0.5, f64::NAN, 10.0, 0.0, false, &cf);
        c.tick(f64::NAN, 0.0, 4.0, 0.0, 0.0, 0.0);
        c.tick(f64::NAN, 0.0, 4.0, 10.0, 10.0, 0.0);
        assert!((c.effective(0, 0, 5) - 0.25).abs() < 1e-12);
        c.sources[0].remote_abs[5] = 0.75;
        c.tick(f64::NAN, 0.0, 4.0, 20.0, 10.0, 0.0);
        assert!((c.effective(0, 0, 5) - 0.75).abs() < 1e-12, "remote absolute wins");
    }
}
