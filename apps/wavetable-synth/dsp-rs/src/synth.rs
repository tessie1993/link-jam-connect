//! Voice engine: 2 wavetable oscillators (morph, unison, stereo spread) + sub + noise -> stereo SVF
//! (LP12/LP24/BP/HP/Notch, drive, key tracking, Env 2) -> amp (Env 1, velocity) -> pan; voices are
//! summed and go through chorus -> Link-synced delay -> reverb -> master/limiter.
//! Modulation: 3 ADSR, 2 LFOs (free / note retrigger / locked to the Link beat), velocity, mod wheel,
//! key track, aftertouch, random and pitch bend through the matrix (normalized offsets).
//!
//! Control values are evaluated once per control block (cfg.control_block samples); note events
//! are sample-accurate (blocks are split at event offsets). The process path never allocates.

use crate::cfg::Cfg;
use crate::fx::{Chorus, Delay, Master, Reverb};
use crate::params::*;
use crate::wavetable::{factory_tables, mip_level_index, table_from_samples, Table, TableCfg};

pub const MAX_UNISON_CAP: usize = 16;
pub const MAX_VOICES_CAP: usize = 64;
pub const MAX_DIVISIONS: usize = 32;
pub const MAX_EVENTS: usize = 512;
pub const MAX_SPAN: usize = 256;
const NOTE_STACK: usize = 128;

pub const CTL_BEND: u32 = 0;
pub const CTL_WHEEL: u32 = 1;
pub const CTL_AFTERTOUCH: u32 = 2;
pub const CTL_SUSTAIN: u32 = 3;

const EV_ON: u32 = 0;
const EV_OFF: u32 = 1;
const EV_CTL: u32 = 2;
const EV_ALL_OFF: u32 = 3;

pub const ST_IDLE: u8 = 0;
pub const ST_ATTACK: u8 = 1;
pub const ST_DECAY: u8 = 2;
pub const ST_SUSTAIN: u8 = 3;
pub const ST_RELEASE: u8 = 4;

const TWO_PI: f32 = core::f32::consts::PI * 2.0;
const TWO_PI_D: f64 = core::f64::consts::PI * 2.0;

#[derive(Clone, Copy)]
struct Event {
    offset: u32,
    kind: u32,
    a: f32,
    b: f32,
}

const NO_EVENT: Event = Event { offset: 0, kind: 0, a: 0.0, b: 0.0 };

#[derive(Clone, Copy)]
struct Pending {
    note: i32,
    vel: f32,
    glide: bool,
    released: bool,
}

pub struct Rng(u32);

impl Rng {
    #[inline]
    pub fn next(&mut self) -> f32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        (x >> 8) as f32 / 16_777_216.0
    }
    #[inline]
    pub fn bi(&mut self) -> f32 {
        self.next() * 2.0 - 1.0
    }
}

#[derive(Clone)]
pub struct Voice {
    pub active: bool,
    pub gate: bool,
    sustained: bool,
    pub note: i32,
    vel: f32,
    order: u64,
    pitch: f32,
    target: f32,
    glide_from: f32,
    glide_left: f32,
    glide_time: f32,
    pub env_stage: [u8; ENV_COUNT],
    pub env_level: [f32; ENV_COUNT],
    lfo_phase: [f64; LFO_COUNT],
    lfo_prev: [f32; LFO_COUNT],
    lfo_next: [f32; LFO_COUNT],
    lfo_val: [f32; LFO_COUNT],
    lfo_cycle: [f64; LFO_COUNT],
    phases: [[f64; MAX_UNISON_CAP]; OSC_COUNT],
    sub_phase: f64,
    pub filt: [f32; 8],
    noise_lp: f32,
    rnd: f32,
    amp: f32,
    fade: f32,
    fade_step: f32,
    pending: Option<Pending>,
}

impl Voice {
    fn new() -> Voice {
        Voice {
            active: false,
            gate: false,
            sustained: false,
            note: 0,
            vel: 0.0,
            order: 0,
            pitch: 0.0,
            target: 0.0,
            glide_from: 0.0,
            glide_left: 0.0,
            glide_time: 0.0,
            env_stage: [ST_IDLE; ENV_COUNT],
            env_level: [0.0; ENV_COUNT],
            lfo_phase: [0.0; LFO_COUNT],
            lfo_prev: [0.0; LFO_COUNT],
            lfo_next: [0.0; LFO_COUNT],
            lfo_val: [0.0; LFO_COUNT],
            lfo_cycle: [0.0; LFO_COUNT],
            phases: [[0.0; MAX_UNISON_CAP]; OSC_COUNT],
            sub_phase: 0.0,
            filt: [0.0; 8],
            noise_lp: 0.0,
            rnd: 0.0,
            amp: 0.0,
            fade: 1.0,
            fade_step: 0.0,
            pending: None,
        }
    }

    fn release(&mut self) {
        self.gate = false;
        self.sustained = false;
        for e in 0..ENV_COUNT {
            if self.env_stage[e] != ST_IDLE {
                self.env_stage[e] = ST_RELEASE;
            }
        }
    }
}

/// Per-span snapshot of global controller / Link state.
#[derive(Clone, Copy)]
struct Ctl {
    sr: f32,
    dt: f32,
    bend: f32,
    wheel: f32,
    at: f32,
    tempo: f32,
    beat: f64,
}

#[inline]
fn fast_tanh(x: f32) -> f32 {
    if x > 3.0 {
        1.0
    } else if x < -3.0 {
        -1.0
    } else {
        let x2 = x * x;
        x * (27.0 + x2) / (27.0 + 9.0 * x2)
    }
}

#[inline]
fn flush(x: f32) -> f32 {
    if x.abs() < 1e-20 {
        0.0
    } else {
        x
    }
}

fn lfo_rate(p: &Params, l: usize, rate_norm: f32, tempo: f32, div: &[f32; MAX_DIVISIONS]) -> f32 {
    if p.on(lfo(l, L_SYNC)) && tempo > 0.0 {
        let d = p.vi(lfo(l, L_DIV));
        if d >= 0 && (d as usize) < MAX_DIVISIONS && div[d as usize] > 0.0 {
            return tempo / 60.0 / div[d as usize];
        }
    }
    let i = lfo(l, L_RATE);
    denorm(&p.info[i], rate_norm)
}

fn source(vc: &Voice, src: usize, c: &Ctl, cfg: &Cfg) -> f32 {
    match src {
        S_ENV1 => vc.env_level[0],
        S_ENV2 => vc.env_level[1],
        S_ENV3 => vc.env_level[2],
        S_LFO1 => vc.lfo_val[0],
        S_LFO2 => vc.lfo_val[1],
        S_VEL => vc.vel,
        S_WHEEL => c.wheel,
        S_KEY => (vc.note as f32 - cfg.keytrack_center) / cfg.keytrack_span,
        S_AT => c.at,
        S_RAND => vc.rnd,
        S_BEND => c.bend,
        _ => 0.0,
    }
}

fn matrix(vc: &Voice, p: &Params, c: &Ctl, cfg: &Cfg, dmod: &mut [f32; N_DESTS]) {
    for d in dmod.iter_mut() {
        *d = 0.0;
    }
    for s in 0..MAX_MOD_SLOTS {
        let src = p.vi(mod_param(s, M_SRC));
        let dst = p.vi(mod_param(s, M_DST));
        if src <= 0 || dst <= 0 || dst as usize >= N_DESTS {
            continue;
        }
        let amt = p.v(mod_param(s, M_AMT));
        if amt != 0.0 {
            dmod[dst as usize] += source(vc, src as usize, c, cfg) * amt;
        }
    }
}

fn advance_envs(vc: &mut Voice, p: &Params, dt: f32, kill: f32, env_k: f32) {
    for e in 0..ENV_COUNT {
        let a = p.v(env(e, E_A)).max(1e-4);
        let d = p.v(env(e, E_D)).max(1e-4);
        let s = clamp01(p.v(env(e, E_S)));
        let r = p.v(env(e, E_R)).max(1e-4);
        let mut lvl = vc.env_level[e];
        match vc.env_stage[e] {
            ST_ATTACK => {
                lvl += dt / a;
                if lvl >= 1.0 {
                    lvl = 1.0;
                    vc.env_stage[e] = ST_DECAY;
                }
            }
            ST_DECAY => {
                lvl = s + (lvl - s) * (-dt * env_k / d).exp();
                if (lvl - s).abs() < kill {
                    lvl = s;
                    vc.env_stage[e] = ST_SUSTAIN;
                }
            }
            ST_SUSTAIN => lvl = s,
            ST_RELEASE => {
                lvl *= (-dt * env_k / r).exp();
                if lvl < kill {
                    lvl = 0.0;
                    vc.env_stage[e] = ST_IDLE;
                }
            }
            _ => lvl = 0.0,
        }
        vc.env_level[e] = flush(lvl);
    }
}

fn advance_lfos(vc: &mut Voice, p: &Params, c: &Ctl, div: &[f32; MAX_DIVISIONS], rng: &mut Rng, rate_mod: [f32; LFO_COUNT]) {
    for l in 0..LFO_COUNT {
        let rate = lfo_rate(p, l, clamp01(p.norm[lfo(l, L_RATE)] + rate_mod[l]), c.tempo, div);
        let retrig = p.vi(lfo(l, L_RETRIG));
        let mut ph = vc.lfo_phase[l];
        let mut wrapped = false;
        if retrig == 2 && c.tempo > 0.0 {
            // locked to the Link timeline
            let cycles_per_beat = (rate as f64 * 60.0) / c.tempo as f64;
            let pos = c.beat * cycles_per_beat + p.v(lfo(l, L_PHASE)) as f64;
            let cycle = pos.floor();
            wrapped = cycle != vc.lfo_cycle[l];
            vc.lfo_cycle[l] = cycle;
            ph = pos - cycle;
        } else {
            ph += rate as f64 * c.dt as f64;
            if ph >= 1.0 {
                ph -= ph.floor();
                wrapped = true;
            }
        }
        if wrapped {
            vc.lfo_prev[l] = vc.lfo_next[l];
            vc.lfo_next[l] = rng.bi();
        }
        vc.lfo_phase[l] = ph;
        let phf = ph as f32;
        let y = match p.vi(lfo(l, L_SHAPE)) {
            0 => (TWO_PI_D * ph).sin() as f32,
            1 => {
                if phf < 0.25 {
                    4.0 * phf
                } else if phf < 0.75 {
                    2.0 - 4.0 * phf
                } else {
                    4.0 * phf - 4.0
                }
            }
            2 => 2.0 * phf - 1.0,
            3 => 1.0 - 2.0 * phf,
            4 => {
                if phf < 0.5 {
                    1.0
                } else {
                    -1.0
                }
            }
            5 => vc.lfo_next[l],
            _ => {
                let t = phf * phf * (3.0 - 2.0 * phf);
                vc.lfo_prev[l] + (vc.lfo_next[l] - vc.lfo_prev[l]) * t
            }
        };
        vc.lfo_val[l] = y;
    }
}

pub struct Synth {
    sr: f32,
    pub cfg: Cfg,
    pub params: Params,
    divisions: [f32; MAX_DIVISIONS],
    pub tables: Vec<Table>,
    table_cfg: TableCfg,
    pub voices: Vec<Voice>,
    events: [Event; MAX_EVENTS],
    n_events: usize,
    rng: Rng,
    order: u64,
    stack: [i32; NOTE_STACK],
    stack_len: usize,
    last_pitch: Option<f32>,
    bend: f32,
    wheel: f32,
    aftertouch: f32,
    sustain: bool,
    global_lfo: [f64; LFO_COUNT],
    tempo: f32,
    block_beat: f64,
    pub playing: bool,
    dmod: [f32; N_DESTS],
    view_dmod: [f32; N_DESTS],
    view_order: u64,
    pub mod_view: [f32; PARAM_CAPACITY],
    tmp_l: Vec<f32>,
    tmp_r: Vec<f32>,
    chorus: Chorus,
    delay: Delay,
    reverb: Reverb,
    master: Master,
    fx_on: [bool; 3],
    pub peak: [f32; 2],
    kill: f32,
    env_k: f32,
    steal_fade: f32,
    cb: usize,
    last_mode: i32,
}

impl Synth {
    pub fn new(sr: f32, cfg_values: &[f32]) -> Synth {
        let sr = if sr > 0.0 { sr } else { 48000.0 };
        let cfg = Cfg::from_slice(cfg_values);
        let table_cfg = TableCfg {
            frames: cfg.table_frames,
            base_harmonics: cfg.table_base_harmonics,
            oversample: cfg.table_oversample,
            min_size: cfg.table_min_size,
            max_frames: cfg.table_max_frames,
        };
        let voices = vec![Voice::new(); cfg.max_polyphony.min(MAX_VOICES_CAP)];
        Synth {
            sr,
            params: Params::new(),
            divisions: [0.0; MAX_DIVISIONS],
            tables: factory_tables(&table_cfg),
            table_cfg,
            voices,
            events: [NO_EVENT; MAX_EVENTS],
            n_events: 0,
            rng: Rng(cfg.random_seed),
            order: 0,
            stack: [0; NOTE_STACK],
            stack_len: 0,
            last_pitch: None,
            bend: 0.0,
            wheel: 0.0,
            aftertouch: 0.0,
            sustain: false,
            global_lfo: [0.0; LFO_COUNT],
            tempo: 0.0,
            block_beat: 0.0,
            playing: false,
            dmod: [0.0; N_DESTS],
            view_dmod: [0.0; N_DESTS],
            view_order: 0,
            mod_view: [0.0; PARAM_CAPACITY],
            tmp_l: vec![0.0; MAX_SPAN],
            tmp_r: vec![0.0; MAX_SPAN],
            chorus: Chorus::new(sr, &cfg),
            delay: Delay::new(sr, &cfg),
            reverb: Reverb::new(sr, &cfg),
            master: Master::new(sr, &cfg),
            fx_on: [false; 3],
            peak: [0.0; 2],
            kill: db_to_amp(cfg.voice_kill_db),
            env_k: (1.0 / cfg.env_curve_epsilon).ln(),
            steal_fade: (cfg.steal_fade_ms / 1000.0 * sr).round().max(1.0),
            cb: cfg.control_block.max(1).min(MAX_SPAN),
            last_mode: 0,
            cfg,
        }
    }

    pub fn sample_rate(&self) -> f32 {
        self.sr
    }

    pub fn set_param_info(&mut self, i: usize, min: f32, max: f32, scale: u32, steps: u32) {
        self.params.set_info(i, ParamInfo { min, max, scale, steps });
    }

    pub fn set_division(&mut self, i: usize, beats: f32) {
        if i < MAX_DIVISIONS {
            self.divisions[i] = beats.max(0.0);
        }
    }

    /// Link state at the start of the next process() call. tempo <= 0: no Link tempo.
    pub fn set_link(&mut self, tempo: f32, beat: f64, playing: bool) {
        self.tempo = if tempo > 0.0 && tempo.is_finite() { tempo } else { 0.0 };
        self.block_beat = if beat.is_finite() { beat } else { 0.0 };
        self.playing = playing;
    }

    // ------------------------------------------------------------------ event queue

    fn queue(&mut self, e: Event) {
        if self.n_events >= MAX_EVENTS {
            return;
        }
        let mut i = self.n_events;
        while i > 0 && self.events[i - 1].offset > e.offset {
            self.events[i] = self.events[i - 1];
            i -= 1;
        }
        self.events[i] = e;
        self.n_events += 1;
    }

    fn pop(&mut self) -> Event {
        let e = self.events[0];
        for i in 1..self.n_events {
            self.events[i - 1] = self.events[i];
        }
        self.n_events -= 1;
        e
    }

    pub fn note_on(&mut self, note: i32, vel: f32, offset: u32) {
        self.queue(Event { offset, kind: EV_ON, a: note as f32, b: vel });
    }
    pub fn note_off(&mut self, note: i32, offset: u32) {
        self.queue(Event { offset, kind: EV_OFF, a: note as f32, b: 0.0 });
    }
    pub fn controller(&mut self, kind: u32, value: f32, offset: u32) {
        self.queue(Event { offset, kind: EV_CTL, a: kind as f32, b: value });
    }
    pub fn all_notes_off(&mut self, hard: bool, offset: u32) {
        if hard {
            self.n_events = 0;
            self.stack_len = 0;
            for v in self.voices.iter_mut() {
                *v = Voice::new();
            }
        } else {
            self.queue(Event { offset, kind: EV_ALL_OFF, a: 0.0, b: 0.0 });
        }
    }

    fn apply(&mut self, e: Event) {
        match e.kind {
            EV_ON => self.note_on_now(e.a as i32, e.b),
            EV_OFF => self.note_off_now(e.a as i32),
            EV_CTL => self.controller_now(e.a as u32, e.b),
            EV_ALL_OFF => self.release_all(),
            _ => {}
        }
    }

    fn controller_now(&mut self, kind: u32, value: f32) {
        let v = if value.is_finite() { value } else { 0.0 };
        match kind {
            CTL_BEND => self.bend = v.max(-1.0).min(1.0),
            CTL_WHEEL => self.wheel = clamp01(v),
            CTL_AFTERTOUCH => self.aftertouch = clamp01(v),
            CTL_SUSTAIN => {
                self.sustain = v >= 0.5;
                if !self.sustain {
                    for vc in self.voices.iter_mut() {
                        if vc.active && vc.sustained {
                            vc.release();
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn release_all(&mut self) {
        self.stack_len = 0;
        for vc in self.voices.iter_mut() {
            vc.pending = None;
            if vc.active {
                vc.release();
            }
        }
    }

    // ------------------------------------------------------------------ voice allocation

    fn glide_active(&self, held_other: bool) -> bool {
        let gm = self.params.vi(VOICE_GLIDE_MODE);
        self.last_pitch.is_some() && (gm == 1 || (gm == 2 && held_other))
    }

    fn note_on_now(&mut self, note: i32, vel: f32) {
        if !(vel > 0.0) || !(0..128).contains(&note) {
            self.note_off_now(note);
            return;
        }
        let vel = vel.min(1.0);
        match self.params.vi(VOICE_MODE) {
            0 => self.poly_on(note, vel),
            m => self.mono_on(note, vel, m == 2),
        }
    }

    fn poly_on(&mut self, note: i32, vel: f32) {
        let held = self.voices.iter().any(|v| v.active && v.gate);
        let glide = self.glide_active(held);
        let poly = (self.params.vi(VOICE_POLY).max(1) as usize).min(self.voices.len());
        if poly == 0 {
            return;
        }
        let same = self.voices.iter().position(|v| v.active && v.note == note && v.pending.is_none());
        let target = match same {
            Some(i) => Some(i),
            None => self.voices[..poly].iter().position(|v| !v.active && v.pending.is_none()),
        };
        match target {
            Some(vi) => {
                let fresh = !self.voices[vi].active;
                self.start_voice(vi, note, vel, glide, fresh);
            }
            None => {
                let vi = self.choose_victim(poly);
                let fade = self.steal_fade;
                let v = &mut self.voices[vi];
                v.pending = Some(Pending { note, vel, glide, released: false });
                v.fade_step = -1.0 / fade;
            }
        }
        self.last_pitch = Some(note as f32);
    }

    /// Released voices first (quietest), else the oldest held voice.
    fn choose_victim(&self, poly: usize) -> usize {
        let pool = &self.voices[..poly];
        let any_free = pool.iter().any(|v| v.pending.is_none());
        let cand = |v: &Voice| !any_free || v.pending.is_none();
        let mut best: Option<usize> = None;
        for (i, v) in pool.iter().enumerate() {
            if cand(v) && !v.gate {
                let better = match best {
                    None => true,
                    Some(b) => v.env_level[0] < pool[b].env_level[0],
                };
                if better {
                    best = Some(i);
                }
            }
        }
        if let Some(b) = best {
            return b;
        }
        let mut oldest = 0usize;
        let mut found = false;
        for (i, v) in pool.iter().enumerate() {
            if cand(v) && (!found || v.order < pool[oldest].order) {
                oldest = i;
                found = true;
            }
        }
        oldest
    }

    fn start_voice(&mut self, vi: usize, note: i32, vel: f32, glide: bool, fresh: bool) {
        self.order += 1;
        let order = self.order;
        let glide_time = self.params.v(VOICE_GLIDE);
        let last = self.last_pitch;
        let mut retrig = [0i32; LFO_COUNT];
        let mut lfo_ph = [0.0f64; LFO_COUNT];
        for l in 0..LFO_COUNT {
            retrig[l] = self.params.vi(lfo(l, L_RETRIG));
            lfo_ph[l] = self.params.v(lfo(l, L_PHASE)) as f64;
        }
        let mut osc_ph = [0.0f32; OSC_COUNT];
        let mut osc_rnd = [0.0f32; OSC_COUNT];
        for o in 0..OSC_COUNT {
            osc_ph[o] = self.params.v(osc(o, O_PHASE));
            osc_rnd[o] = self.params.v(osc(o, O_RAND));
        }
        let global = self.global_lfo;
        let vc = &mut self.voices[vi];
        vc.note = note;
        vc.vel = vel;
        vc.gate = true;
        vc.sustained = false;
        vc.order = order;
        vc.target = note as f32;
        match (glide, last) {
            (true, Some(lp)) => {
                vc.glide_from = if fresh { lp } else { vc.pitch };
                vc.glide_time = glide_time;
                vc.glide_left = glide_time;
                vc.pitch = vc.glide_from;
            }
            _ => {
                vc.pitch = note as f32;
                vc.glide_left = 0.0;
            }
        }
        for e in 0..ENV_COUNT {
            vc.env_stage[e] = ST_ATTACK;
            if fresh {
                vc.env_level[e] = 0.0;
            }
        }
        vc.rnd = self.rng.bi();
        for l in 0..LFO_COUNT {
            if retrig[l] == 1 {
                vc.lfo_phase[l] = lfo_ph[l];
            } else if fresh {
                vc.lfo_phase[l] = global[l];
            }
            if fresh || retrig[l] == 1 {
                vc.lfo_prev[l] = self.rng.bi();
                vc.lfo_next[l] = self.rng.bi();
            }
        }
        if fresh {
            for o in 0..OSC_COUNT {
                for u in 0..MAX_UNISON_CAP {
                    let p = osc_ph[o] as f64 + osc_rnd[o] as f64 * self.rng.next() as f64;
                    vc.phases[o][u] = p - p.floor();
                }
            }
            vc.sub_phase = 0.0;
            vc.filt = [0.0; 8];
            vc.noise_lp = 0.0;
            vc.amp = 0.0;
        }
        vc.fade = 1.0;
        vc.fade_step = 0.0;
        vc.active = true;
        self.view_order = order;
    }

    fn stack_remove(&mut self, note: i32) {
        let mut j = 0;
        for i in 0..self.stack_len {
            if self.stack[i] != note {
                self.stack[j] = self.stack[i];
                j += 1;
            }
        }
        self.stack_len = j;
    }

    fn set_mono_pitch(&mut self, note: i32, glide: bool) {
        let glide_time = self.params.v(VOICE_GLIDE);
        let vc = &mut self.voices[0];
        vc.target = note as f32;
        if glide {
            vc.glide_from = vc.pitch;
            vc.glide_time = glide_time;
            vc.glide_left = glide_time;
        } else {
            vc.pitch = note as f32;
            vc.glide_left = 0.0;
        }
    }

    fn mono_on(&mut self, note: i32, vel: f32, legato: bool) {
        if self.voices.is_empty() {
            return;
        }
        self.stack_remove(note);
        let held = self.stack_len > 0 && self.voices[0].active && self.voices[0].gate;
        if self.stack_len < NOTE_STACK {
            self.stack[self.stack_len] = note;
            self.stack_len += 1;
        }
        let glide = self.glide_active(held);
        if legato && held {
            self.voices[0].note = note;
            self.voices[0].vel = vel;
            self.set_mono_pitch(note, glide);
        } else {
            let fresh = !self.voices[0].active;
            self.start_voice(0, note, vel, glide, fresh);
        }
        self.last_pitch = Some(note as f32);
    }

    fn note_off_now(&mut self, note: i32) {
        if self.params.vi(VOICE_MODE) != 0 {
            self.mono_off(note);
            return;
        }
        let sustain = self.sustain;
        for vc in self.voices.iter_mut() {
            if let Some(p) = vc.pending.as_mut() {
                if p.note == note {
                    p.released = true;
                }
            }
            if vc.active && vc.gate && vc.note == note {
                if sustain {
                    vc.sustained = true;
                } else {
                    vc.release();
                }
            }
        }
    }

    fn mono_off(&mut self, note: i32) {
        if self.voices.is_empty() {
            return;
        }
        let was_top = self.stack_len > 0 && self.stack[self.stack_len - 1] == note;
        self.stack_remove(note);
        if !was_top || !self.voices[0].active {
            return;
        }
        if self.stack_len > 0 {
            let prev = self.stack[self.stack_len - 1];
            self.voices[0].note = prev;
            let glide = self.glide_active(true);
            self.set_mono_pitch(prev, glide);
            self.last_pitch = Some(prev as f32);
        } else if self.sustain {
            self.voices[0].sustained = true;
        } else {
            self.voices[0].release();
        }
    }

    pub fn active_voices(&self) -> u32 {
        self.voices.iter().filter(|v| v.active).count() as u32
    }

    // ------------------------------------------------------------------ tables

    /// Build a table from mono samples sliced into frames of `frame_size`; slot == table count appends.
    /// Returns the slot, or a negative error code. Allocates: never call from the audio callback.
    pub fn load_table(&mut self, slot: usize, samples: &[f32], frame_size: usize) -> i32 {
        let appending = slot == self.tables.len();
        if slot > self.tables.len() || (appending && slot >= self.cfg.max_tables.max(self.tables.len())) {
            return -1;
        }
        match table_from_samples(samples, frame_size, &self.table_cfg) {
            None => -2,
            Some(t) => {
                if slot == self.tables.len() {
                    self.tables.push(t);
                } else {
                    self.tables[slot] = t;
                }
                slot as i32
            }
        }
    }

    // ------------------------------------------------------------------ rendering

    pub fn delay_time(&self) -> f32 {
        if self.params.on(DELAY_SYNC) && self.tempo > 0.0 {
            let d = self.params.vi(DELAY_DIV);
            if d >= 0 && (d as usize) < MAX_DIVISIONS && self.divisions[d as usize] > 0.0 {
                return self.divisions[d as usize] * 60.0 / self.tempo;
            }
        }
        self.params.v(DELAY_TIME)
    }

    /// Render `frames = min(out_l.len(), out_r.len())` samples (overwrites the outputs).
    pub fn process(&mut self, out_l: &mut [f32], out_r: &mut [f32]) {
        let frames = out_l.len().min(out_r.len());
        let out_l = &mut out_l[..frames];
        let out_r = &mut out_r[..frames];
        for i in 0..frames {
            out_l[i] = 0.0;
            out_r[i] = 0.0;
        }
        let mut pos = 0usize;
        while pos < frames {
            while self.n_events > 0 && (self.events[0].offset as usize) <= pos {
                let e = self.pop();
                self.apply(e);
            }
            let mut end = (pos + self.cb).min(frames);
            if self.n_events > 0 {
                let o = self.events[0].offset as usize;
                if o > pos && o < end {
                    end = o;
                }
            }
            self.render_span(out_l, out_r, pos, end);
            pos = end;
        }
        for i in 0..self.n_events {
            self.events[i].offset = self.events[i].offset.saturating_sub(frames as u32);
        }
        if self.tempo > 0.0 {
            self.block_beat += frames as f64 / self.sr as f64 * self.tempo as f64 / 60.0;
        }
        self.render_fx(out_l, out_r);
    }

    fn render_span(&mut self, out_l: &mut [f32], out_r: &mut [f32], start: usize, end: usize) {
        let n = end - start;
        if n == 0 {
            return;
        }
        self.params.update();
        let mode = self.params.vi(VOICE_MODE);
        if mode != self.last_mode {
            self.last_mode = mode;
            self.release_all();
        }
        let dt = n as f32 / self.sr;
        let c = Ctl {
            sr: self.sr,
            dt,
            bend: self.bend,
            wheel: self.wheel,
            at: self.aftertouch,
            tempo: self.tempo,
            beat: self.block_beat + start as f64 / self.sr as f64 * self.tempo as f64 / 60.0,
        };
        for l in 0..LFO_COUNT {
            let r = lfo_rate(&self.params, l, self.params.norm[lfo(l, L_RATE)], self.tempo, &self.divisions);
            let ph = self.global_lfo[l] + r as f64 * dt as f64;
            self.global_lfo[l] = ph - ph.floor();
        }
        for vi in 0..self.voices.len() {
            if !self.voices[vi].active {
                continue;
            }
            Self::render_voice(
                &mut self.voices[vi],
                &self.params,
                &self.tables,
                &self.cfg,
                &self.divisions,
                &mut self.rng,
                &mut self.dmod,
                &mut self.tmp_l,
                &mut self.tmp_r,
                &c,
                self.kill,
                self.env_k,
                out_l,
                out_r,
                start,
                end,
            );
            if self.voices[vi].order == self.view_order {
                self.view_dmod = self.dmod;
            }
            let (fading, done, idle) = {
                let v = &self.voices[vi];
                (v.fade_step != 0.0, v.fade <= 0.0, v.env_stage[0] == ST_IDLE && v.pending.is_none())
            };
            if fading && done {
                let p = self.voices[vi].pending.take();
                self.voices[vi].fade_step = 0.0;
                self.voices[vi].active = false;
                if let Some(p) = p {
                    self.start_voice(vi, p.note, p.vel, p.glide, true);
                    if p.released {
                        self.voices[vi].release();
                    }
                }
            } else if idle {
                let v = &mut self.voices[vi];
                v.active = false;
                v.gate = false;
                v.amp = 0.0;
            }
        }
        self.params.advance(n as u32);
    }

    #[allow(clippy::too_many_arguments)]
    fn render_voice(
        vc: &mut Voice,
        p: &Params,
        tables: &[Table],
        cfg: &Cfg,
        div: &[f32; MAX_DIVISIONS],
        rng: &mut Rng,
        dmod: &mut [f32; N_DESTS],
        tl: &mut [f32],
        tr: &mut [f32],
        c: &Ctl,
        kill: f32,
        env_k: f32,
        out_l: &mut [f32],
        out_r: &mut [f32],
        start: usize,
        end: usize,
    ) {
        let n = (end - start).min(tl.len()).min(tr.len());
        let sr = c.sr;
        matrix(vc, p, c, cfg, dmod);
        advance_envs(vc, p, c.dt, kill, env_k);
        advance_lfos(vc, p, c, div, rng, [dmod[D_LFO1_RATE], dmod[D_LFO2_RATE]]);
        matrix(vc, p, c, cfg, dmod);

        if vc.glide_left > 0.0 {
            vc.glide_left = (vc.glide_left - c.dt).max(0.0);
            let x = if vc.glide_time > 0.0 { vc.glide_left / vc.glide_time } else { 0.0 };
            vc.pitch = vc.target + (vc.glide_from - vc.target) * x;
        } else {
            vc.pitch = vc.target;
        }

        for i in 0..n {
            tl[i] = 0.0;
            tr[i] = 0.0;
        }
        let pitch_all = vc.pitch + c.bend * p.v(VOICE_BEND) + dmod[D_PITCH] * cfg.mod_pitch_semis;
        let a4 = cfg.tuning_a4;

        // ---- wavetable oscillators
        for o in 0..OSC_COUNT {
            if !p.on(osc(o, O_ON)) || tables.is_empty() {
                continue;
            }
            let ti = p.vi(osc(o, O_TABLE)).max(0) as usize;
            let table = if ti < tables.len() { &tables[ti] } else { &tables[0] };
            if table.frames == 0 || table.levels.is_empty() {
                continue;
            }
            let level = p.eff(osc(o, O_LEVEL), dmod[d_osc_level(o)]);
            if !(level > 0.0) {
                continue;
            }
            let semis = pitch_all
                + 12.0 * p.v(osc(o, O_OCT))
                + p.v(osc(o, O_SEMI))
                + p.v(osc(o, O_FINE)) / 100.0
                + dmod[d_osc_pitch(o)] * cfg.mod_pitch_semis;
            let base_inc = (a4 * ((semis - 69.0) / 12.0).exp2() / sr) as f64;
            let unison_cap = cfg.max_unison.min(MAX_UNISON_CAP).max(1);
            let u_count = (p.vi(osc(o, O_UNISON)).max(1) as usize).min(unison_cap);
            let detune = p.eff(osc(o, O_DETUNE), dmod[d_osc_detune(o)]);
            let spread = p.v(osc(o, O_SPREAD));
            let pan = p.v(osc(o, O_PAN));
            let max_inc = if u_count > 1 { base_inc * ((detune.abs() / 1200.0) as f64).exp2() } else { base_inc };
            let lv = match mip_level_index(table, max_inc) {
                Some(k) => &table.levels[k],
                None => continue,
            };
            let size = lv.size;
            let mask = size - 1;
            let pos = clamp01(p.norm[osc(o, O_POS)] + dmod[d_osc_pos(o)]);
            let fpos = pos * (table.frames - 1) as f32;
            let f0 = (fpos.floor() as usize).min(table.frames - 1);
            let f1 = (f0 + 1).min(table.frames - 1);
            let mf = fpos - f0 as f32;
            if lv.data.len() < table.frames * size {
                continue;
            }
            let fa = &lv.data[f0 * size..(f0 + 1) * size];
            let fb = &lv.data[f1 * size..(f1 + 1) * size];
            let uni_gain = level / (u_count as f32).sqrt();
            let sizef = size as f64;
            for u in 0..u_count {
                let sp = if u_count > 1 { 2.0 * u as f32 / (u_count - 1) as f32 - 1.0 } else { 0.0 };
                let inc = base_inc * ((detune * sp / 1200.0) as f64).exp2();
                let pp = (pan + spread * sp).max(-1.0).min(1.0);
                let ang = (pp + 1.0) * core::f32::consts::FRAC_PI_4;
                let gl = ang.cos() * uni_gain * core::f32::consts::SQRT_2;
                let gr = ang.sin() * uni_gain * core::f32::consts::SQRT_2;
                let mut ph = vc.phases[o][u];
                for i in 0..n {
                    let x = ph * sizef;
                    let xi = x.floor();
                    let fr = (x - xi) as f32;
                    let i0 = (xi as usize) & mask;
                    let i1 = (i0 + 1) & mask;
                    let a0 = fa[i0];
                    let b0 = fb[i0];
                    let sa = a0 + (fa[i1] - a0) * fr;
                    let sb = b0 + (fb[i1] - b0) * fr;
                    let s = sa + (sb - sa) * mf;
                    tl[i] += s * gl;
                    tr[i] += s * gr;
                    ph += inc;
                    if ph >= 1.0 {
                        ph -= 1.0;
                    }
                }
                vc.phases[o][u] = ph;
            }
        }

        // ---- sub oscillator (follows the played pitch)
        let sub_level = p.eff(SUB_LEVEL, dmod[D_SUB_LEVEL]);
        if sub_level > 0.0 {
            let oct = (p.vi(SUB_OCT).max(0) + 1) as f32;
            let inc = (a4 * ((pitch_all - 12.0 * oct - 69.0) / 12.0).exp2() / sr) as f64;
            let shape = p.vi(SUB_SHAPE);
            let mut ph = vc.sub_phase;
            if inc < 0.5 {
                for i in 0..n {
                    let phf = ph as f32;
                    let incf = inc as f32;
                    let s = match shape {
                        0 => (TWO_PI_D * ph).sin() as f32,
                        1 => {
                            if phf < 0.25 {
                                4.0 * phf
                            } else if phf < 0.75 {
                                2.0 - 4.0 * phf
                            } else {
                                4.0 * phf - 4.0
                            }
                        }
                        _ => {
                            let mut s = if phf < 0.5 { 1.0 } else { -1.0 };
                            s += poly_blep(phf, incf);
                            let mut t = phf - 0.5;
                            if t < 0.0 {
                                t += 1.0;
                            }
                            s -= poly_blep(t, incf);
                            s
                        }
                    };
                    let v = s * sub_level;
                    tl[i] += v;
                    tr[i] += v;
                    ph += inc;
                    if ph >= 1.0 {
                        ph -= 1.0;
                    }
                }
            }
            vc.sub_phase = ph;
        }

        // ---- noise (white, tilted by colour)
        let noise_level = p.eff(NOISE_LEVEL, dmod[D_NOISE_LEVEL]);
        if noise_level > 0.0 {
            let color = p.v(NOISE_COLOR);
            let k = cfg.noise_tilt;
            let mut lp = vc.noise_lp;
            for i in 0..n {
                let w = rng.bi();
                lp += (w - lp) * k;
                let s = if color < 0.0 { w + (lp - w) * -color } else { w - lp * color };
                let v = s * noise_level;
                tl[i] += v;
                tr[i] += v;
            }
            vc.noise_lp = flush(lp);
        }

        // ---- filter
        if p.on(FILTER_ON) {
            let cutoff = p.eff(FILTER_CUTOFF, dmod[D_CUTOFF]);
            let oct = p.v(FILTER_KEY) * ((vc.note as f32 - cfg.keytrack_center) / 12.0)
                + p.v(FILTER_ENV) * cfg.filter_env_octaves * vc.env_level[1];
            let fc = (cutoff * oct.exp2()).max(cfg.filter_min_hz).min(sr * cfg.filter_max_ratio);
            let reso = clamp01(p.eff(FILTER_RESO, dmod[D_RESO]));
            let drive_db = p.eff(FILTER_DRIVE, dmod[D_DRIVE]);
            let ftype = p.vi(FILTER_TYPE);
            let g = (core::f32::consts::PI * fc / sr).tan();
            let kq = 2.0 - 2.0 * reso * cfg.filter_max_resonance;
            let a1 = 1.0 / (1.0 + g * (g + kq));
            let a2 = g * a1;
            let a3 = g * a2;
            let kb = core::f32::consts::SQRT_2;
            let b1 = 1.0 / (1.0 + g * (g + kb));
            let b2 = g * b1;
            let b3 = g * b2;
            let drive = db_to_amp(drive_db);
            let sat = drive_db > cfg.drive_threshold_db;
            let comp = if sat { 1.0 / drive.sqrt() } else { 1.0 };
            for ch in 0..2 {
                let buf: &mut [f32] = if ch == 0 { &mut tl[..n] } else { &mut tr[..n] };
                let o = ch * 4;
                let (mut ic1, mut ic2, mut jc1, mut jc2) = (vc.filt[o], vc.filt[o + 1], vc.filt[o + 2], vc.filt[o + 3]);
                for x_ref in buf.iter_mut() {
                    let mut x = *x_ref;
                    if sat {
                        x = fast_tanh(x * drive) * comp;
                    }
                    let v3 = x - ic2;
                    let v1 = a1 * ic1 + a2 * v3;
                    let v2 = ic2 + a2 * ic1 + a3 * v3;
                    ic1 = 2.0 * v1 - ic1;
                    ic2 = 2.0 * v2 - ic2;
                    let y = match ftype {
                        0 => v2,
                        1 => {
                            let w3 = v2 - jc2;
                            let w1 = b1 * jc1 + b2 * w3;
                            let w2 = jc2 + b2 * jc1 + b3 * w3;
                            jc1 = 2.0 * w1 - jc1;
                            jc2 = 2.0 * w2 - jc2;
                            w2
                        }
                        2 => v1 * kq,
                        3 => x - kq * v1 - v2,
                        _ => x - kq * v1,
                    };
                    *x_ref = y;
                }
                vc.filt[o] = flush(ic1);
                vc.filt[o + 1] = flush(ic2);
                vc.filt[o + 2] = flush(jc1);
                vc.filt[o + 3] = flush(jc2);
            }
        }

        // ---- amp + pan (amplitude interpolated across the block; steal fade per sample)
        let vel_sens = p.v(AMP_VELSENS);
        let vel_gain = 1.0 - vel_sens + vel_sens * vc.vel.max(0.0).powf(cfg.velocity_curve);
        let amp_target = vc.env_level[0] * vel_gain * db_to_amp(p.eff(AMP_LEVEL, dmod[D_AMP]));
        let pan = dmod[D_PAN].max(-1.0).min(1.0);
        let pl = (1.0 - pan).min(1.0);
        let pr = (1.0 + pan).min(1.0);
        let mut amp = vc.amp;
        let d_amp = if n > 0 { (amp_target - amp) / n as f32 } else { 0.0 };
        let mut fade = vc.fade;
        let fs = vc.fade_step;
        for i in 0..n {
            amp += d_amp;
            if fs != 0.0 {
                fade = (fade + fs).max(0.0);
            }
            let gg = amp * fade;
            out_l[start + i] += tl[i] * gg * pl;
            out_r[start + i] += tr[i] * gg * pr;
        }
        vc.amp = amp_target;
        vc.fade = fade;
    }

    fn render_fx(&mut self, out_l: &mut [f32], out_r: &mut [f32]) {
        let p = &self.params;
        let ch = p.on(CHORUS_ON);
        let de = p.on(DELAY_ON);
        let rv = p.on(REVERB_ON);
        if ch && !self.fx_on[0] {
            self.chorus.reset();
        }
        if de && !self.fx_on[1] {
            self.delay.reset();
        }
        if rv && !self.fx_on[2] {
            self.reverb.reset();
        }
        self.fx_on = [ch, de, rv];
        let dtime = self.delay_time();
        let p = &self.params;
        if ch {
            self.chorus.process(out_l, out_r, p.v(CHORUS_RATE), p.v(CHORUS_DEPTH), p.v(CHORUS_MIX));
        }
        if de {
            self.delay.process(out_l, out_r, dtime, p.v(DELAY_FEEDBACK), p.v(DELAY_MIX), p.on(DELAY_PINGPONG), p.v(DELAY_TONE));
        }
        if rv {
            self.reverb.process(out_l, out_r, p.v(REVERB_SIZE), p.v(REVERB_DAMP), p.v(REVERB_MIX));
        }
        self.master.process(out_l, out_r, db_to_amp(p.v(MASTER_GAIN)), p.on(MASTER_LIMIT), db_to_amp(p.v(MASTER_CEILING)));
        for i in 0..out_l.len() {
            self.peak[0] = self.peak[0].max(out_l[i].abs());
            self.peak[1] = self.peak[1].max(out_r[i].abs());
        }
    }

    pub fn limiter_reduction(&self) -> f32 {
        self.master.reduction
    }

    /// Effective normalized values (base + matrix offsets of the newest voice) for the UI rings.
    pub fn update_mod_view(&mut self) {
        let any = self.voices.iter().any(|v| v.active && v.order == self.view_order);
        for i in 0..PARAM_CAPACITY {
            self.mod_view[i] = self.params.norm[i];
        }
        if any {
            for d in 0..N_DESTS {
                if let Some(i) = dest_param(d) {
                    self.mod_view[i] = clamp01(self.params.norm[i] + self.view_dmod[d]);
                }
            }
        }
    }
}

#[inline]
fn poly_blep(t: f32, dt: f32) -> f32 {
    if dt <= 0.0 {
        0.0
    } else if t < dt {
        let x = t / dt;
        x + x - x * x - 1.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt;
        x * x + x + x + 1.0
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cfg::CONFIG_KEYS;

    const SR: f32 = 48000.0;

    /// Test fixture: a config close to the shipped jamconnect.config.json.
    fn cfg_values(max_voices: f32) -> Vec<f32> {
        CONFIG_KEYS
            .iter()
            .map(|k| match *k {
                "engine.maxPolyphony" => max_voices,
                "engine.maxUnison" => 8.0,
                "engine.controlBlock" => 16.0,
                "engine.stealFadeMs" => 3.0,
                "engine.voiceKillDb" => -96.0,
                "engine.envCurveEpsilon" => 0.001,
                "engine.velocityCurve" => 1.5,
                "engine.filterEnvOctaves" => 8.0,
                "engine.filterMinHz" => 20.0,
                "engine.filterMaxRatio" => 0.45,
                "engine.filterMaxResonance" => 0.98,
                "engine.driveThresholdDb" => 0.1,
                "engine.modPitchSemis" => 24.0,
                "engine.keytrackCenterNote" => 60.0,
                "engine.keytrackSpanSemis" => 60.0,
                "engine.noiseTiltCoef" => 0.1,
                "engine.tuningA4" => 440.0,
                "engine.chorusBaseMs" => 12.0,
                "engine.chorusDepthMs" => 8.0,
                "engine.delayMaxSec" => 4.0,
                "engine.delaySmoothMs" => 60.0,
                "engine.reverbMinDecaySec" => 0.3,
                "engine.reverbMaxDecaySec" => 12.0,
                "engine.reverbDampMax" => 0.9,
                "engine.reverbDiffusion" => 0.6,
                "engine.limiterLookaheadMs" => 2.0,
                "engine.limiterReleaseMs" => 120.0,
                "engine.gainSmoothMs" => 20.0,
                "wavetable.frames" => 16.0,
                "wavetable.baseHarmonics" => 128.0,
                "wavetable.oversample" => 4.0,
                "wavetable.minTableSize" => 64.0,
                "wavetable.maxFrames" => 64.0,
                "wavetable.maxTables" => 16.0,
                "engine.randomSeed" => 12345.0,
                k if k.starts_with("engine.reverbDelaysMs") => 29.7 + 6.0 * (k.as_bytes()[22] - b'0') as f32,
                k if k.starts_with("engine.reverbDiffusersMs") => 4.7 + 1.3 * (k.as_bytes()[25] - b'0') as f32,
                other => panic!("no fixture for {}", other),
            })
            .collect()
    }

    fn info(s: &mut Synth, i: usize, min: f32, max: f32, scale: u32, steps: u32, norm: f32) {
        s.set_param_info(i, min, max, scale, steps);
        s.params.set(i, norm);
    }

    fn items(s: &mut Synth, i: usize, n: u32, index: u32) {
        info(s, i, 0.0, (n - 1) as f32, SCALE_LIN, n, index as f32 / (n - 1) as f32);
    }

    fn synth(max_voices: f32, poly: u32) -> Synth {
        let mut s = Synth::new(SR, &cfg_values(max_voices));
        for o in 0..OSC_COUNT {
            items(&mut s, osc(o, O_ON), 2, if o == 0 { 1 } else { 0 });
            items(&mut s, osc(o, O_TABLE), 7, 0);
            info(&mut s, osc(o, O_POS), 0.0, 1.0, SCALE_LIN, 0, 0.66);
            info(&mut s, osc(o, O_OCT), -3.0, 3.0, SCALE_LIN, 7, 0.5);
            info(&mut s, osc(o, O_SEMI), -12.0, 12.0, SCALE_LIN, 25, 0.5);
            info(&mut s, osc(o, O_FINE), -100.0, 100.0, SCALE_LIN, 0, 0.5);
            info(&mut s, osc(o, O_LEVEL), 0.0, 1.0, SCALE_LIN, 0, 0.8);
            info(&mut s, osc(o, O_PAN), -1.0, 1.0, SCALE_LIN, 0, 0.5);
            info(&mut s, osc(o, O_UNISON), 1.0, 8.0, SCALE_LIN, 8, 0.0);
            info(&mut s, osc(o, O_DETUNE), 0.0, 100.0, SCALE_LIN, 0, 0.2);
            info(&mut s, osc(o, O_SPREAD), 0.0, 1.0, SCALE_LIN, 0, 0.5);
            info(&mut s, osc(o, O_PHASE), 0.0, 1.0, SCALE_LIN, 0, 0.0);
            info(&mut s, osc(o, O_RAND), 0.0, 1.0, SCALE_LIN, 0, 1.0);
        }
        info(&mut s, SUB_LEVEL, 0.0, 1.0, SCALE_LIN, 0, 0.0);
        items(&mut s, SUB_OCT, 2, 0);
        items(&mut s, SUB_SHAPE, 3, 0);
        info(&mut s, NOISE_LEVEL, 0.0, 1.0, SCALE_LIN, 0, 0.0);
        info(&mut s, NOISE_COLOR, -1.0, 1.0, SCALE_LIN, 0, 0.5);
        items(&mut s, FILTER_ON, 2, 1);
        items(&mut s, FILTER_TYPE, 5, 1);
        info(&mut s, FILTER_CUTOFF, 20.0, 20000.0, SCALE_EXP, 0, 0.8);
        info(&mut s, FILTER_RESO, 0.0, 1.0, SCALE_LIN, 0, 0.2);
        info(&mut s, FILTER_DRIVE, 0.0, 24.0, SCALE_LIN, 0, 0.0);
        info(&mut s, FILTER_KEY, 0.0, 1.0, SCALE_LIN, 0, 0.0);
        info(&mut s, FILTER_ENV, -1.0, 1.0, SCALE_LIN, 0, 0.5);
        info(&mut s, AMP_LEVEL, -60.0, 0.0, SCALE_DB, 0, 0.5);
        info(&mut s, AMP_VELSENS, 0.0, 1.0, SCALE_LIN, 0, 0.5);
        for e in 0..ENV_COUNT {
            // 0.001..20 s exp: a ~1.6 ms, d ~50 ms, r ~20 ms
            info(&mut s, env(e, E_A), 0.001, 20.0, SCALE_EXP, 0, 0.05);
            info(&mut s, env(e, E_D), 0.001, 20.0, SCALE_EXP, 0, 0.4);
            info(&mut s, env(e, E_S), 0.0, 1.0, SCALE_LIN, 0, 0.7);
            info(&mut s, env(e, E_R), 0.001, 20.0, SCALE_EXP, 0, 0.3);
        }
        for l in 0..LFO_COUNT {
            items(&mut s, lfo(l, L_SHAPE), 7, 0);
            info(&mut s, lfo(l, L_RATE), 0.01, 40.0, SCALE_EXP, 0, 0.5);
            items(&mut s, lfo(l, L_SYNC), 2, 0);
            items(&mut s, lfo(l, L_DIV), 4, 2);
            items(&mut s, lfo(l, L_RETRIG), 3, 0);
            info(&mut s, lfo(l, L_PHASE), 0.0, 1.0, SCALE_LIN, 0, 0.0);
        }
        items(&mut s, VOICE_MODE, 3, 0);
        info(&mut s, VOICE_POLY, 1.0, 16.0, SCALE_LIN, 16, (poly as f32 - 1.0) / 15.0);
        items(&mut s, VOICE_GLIDE_MODE, 3, 0);
        info(&mut s, VOICE_GLIDE, 0.001, 5.0, SCALE_EXP, 0, 0.3);
        info(&mut s, VOICE_BEND, 0.0, 24.0, SCALE_LIN, 25, 2.0 / 24.0);
        items(&mut s, CHORUS_ON, 2, 0);
        info(&mut s, CHORUS_RATE, 0.05, 8.0, SCALE_EXP, 0, 0.4);
        info(&mut s, CHORUS_DEPTH, 0.0, 1.0, SCALE_LIN, 0, 0.4);
        info(&mut s, CHORUS_MIX, 0.0, 1.0, SCALE_LIN, 0, 0.4);
        items(&mut s, DELAY_ON, 2, 0);
        items(&mut s, DELAY_SYNC, 2, 1);
        items(&mut s, DELAY_DIV, 4, 2);
        info(&mut s, DELAY_TIME, 0.01, 2.0, SCALE_EXP, 0, 0.5);
        info(&mut s, DELAY_FEEDBACK, 0.0, 0.95, SCALE_LIN, 0, 0.5);
        info(&mut s, DELAY_MIX, 0.0, 1.0, SCALE_LIN, 0, 0.3);
        items(&mut s, DELAY_PINGPONG, 2, 1);
        info(&mut s, DELAY_TONE, 500.0, 20000.0, SCALE_EXP, 0, 0.6);
        items(&mut s, REVERB_ON, 2, 0);
        info(&mut s, REVERB_SIZE, 0.0, 1.0, SCALE_LIN, 0, 0.6);
        info(&mut s, REVERB_DAMP, 0.0, 1.0, SCALE_LIN, 0, 0.4);
        info(&mut s, REVERB_MIX, 0.0, 1.0, SCALE_LIN, 0, 0.3);
        info(&mut s, MASTER_GAIN, -60.0, 6.0, SCALE_DB, 0, 0.5);
        items(&mut s, MASTER_LIMIT, 2, 1);
        info(&mut s, MASTER_CEILING, -24.0, 0.0, SCALE_LIN, 0, 23.0 / 24.0);
        for m in 0..MAX_MOD_SLOTS {
            items(&mut s, mod_param(m, M_SRC), 12, 0);
            items(&mut s, mod_param(m, M_DST), 19, 0);
            info(&mut s, mod_param(m, M_AMT), -1.0, 1.0, SCALE_LIN, 0, 0.5);
        }
        for (i, b) in [0.25f32, 0.5, 1.0, 4.0].iter().enumerate() {
            s.set_division(i, *b);
        }
        s
    }

    fn render(s: &mut Synth, blocks: usize) -> (Vec<f32>, Vec<f32>) {
        let mut l_all = Vec::new();
        let mut r_all = Vec::new();
        let mut l = vec![0.0f32; 128];
        let mut r = vec![0.0f32; 128];
        for _ in 0..blocks {
            s.process(&mut l, &mut r);
            l_all.extend_from_slice(&l);
            r_all.extend_from_slice(&r);
        }
        (l_all, r_all)
    }

    #[test]
    fn output_is_finite_and_not_silent() {
        let mut s = synth(8.0, 8);
        // exercise everything: unison, second osc, sub, noise, matrix, FX
        items(&mut s, osc(1, O_ON), 2, 1);
        info(&mut s, osc(0, O_UNISON), 1.0, 8.0, SCALE_LIN, 8, 1.0);
        info(&mut s, SUB_LEVEL, 0.0, 1.0, SCALE_LIN, 0, 0.5);
        items(&mut s, SUB_SHAPE, 3, 2);
        info(&mut s, NOISE_LEVEL, 0.0, 1.0, SCALE_LIN, 0, 0.1);
        items(&mut s, mod_param(0, M_SRC), 12, S_LFO1 as u32);
        items(&mut s, mod_param(0, M_DST), 19, D_CUTOFF as u32);
        info(&mut s, mod_param(0, M_AMT), -1.0, 1.0, SCALE_LIN, 0, 0.9);
        items(&mut s, CHORUS_ON, 2, 1);
        items(&mut s, DELAY_ON, 2, 1);
        items(&mut s, REVERB_ON, 2, 1);
        s.set_link(120.0, 0.0, true);
        for (k, n) in [36, 48, 60, 64, 67, 72, 96, 120].iter().enumerate() {
            s.note_on(*n, 0.9, (k * 10) as u32);
        }
        let (l, r) = render(&mut s, 200);
        assert!(l.iter().chain(r.iter()).all(|x| x.is_finite()), "finite");
        let peak = l.iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!(peak > 0.01, "not silent (peak {})", peak);
        assert!(peak <= 1.0, "limited");
    }

    #[test]
    fn voice_stealing_keeps_newest_notes() {
        let mut s = synth(8.0, 4);
        for n in 60..66 {
            s.note_on(n, 0.8, 0);
        }
        render(&mut s, 20);
        assert!(s.active_voices() <= 4, "poly 4 respected ({})", s.active_voices());
        let notes: Vec<i32> = s.voices.iter().filter(|v| v.active).map(|v| v.note).collect();
        assert!(notes.contains(&64) && notes.contains(&65), "newest notes play: {:?}", notes);
        assert!(!notes.contains(&60) && !notes.contains(&61), "oldest stolen: {:?}", notes);
        // released voices are stolen before held ones
        s.note_off(62, 0);
        render(&mut s, 1);
        s.note_on(70, 0.8, 0);
        render(&mut s, 10);
        let notes: Vec<i32> = s.voices.iter().filter(|v| v.active).map(|v| v.note).collect();
        assert!(notes.contains(&70) && !notes.contains(&62) && notes.contains(&63), "released voice stolen first: {:?}", notes);
    }

    #[test]
    fn envelope_stages() {
        let mut s = synth(4.0, 4);
        info(&mut s, env(0, E_A), 0.001, 20.0, SCALE_EXP, 0, 0.3); // ~19.5 ms
        s.note_on(60, 1.0, 0);
        render(&mut s, 1);
        assert_eq!(s.voices[0].env_stage[0], ST_ATTACK);
        assert!(s.voices[0].env_level[0] > 0.0 && s.voices[0].env_level[0] < 1.0);
        render(&mut s, 10); // 29 ms > attack
        assert!(matches!(s.voices[0].env_stage[0], ST_DECAY | ST_SUSTAIN));
        render(&mut s, 300); // 0.8 s
        assert_eq!(s.voices[0].env_stage[0], ST_SUSTAIN);
        assert!((s.voices[0].env_level[0] - 0.7).abs() < 1e-3);
        s.note_off(60, 0);
        render(&mut s, 1);
        assert_eq!(s.voices[0].env_stage[0], ST_RELEASE);
        render(&mut s, 200);
        assert!(!s.voices[0].active, "voice freed after release");
    }

    #[test]
    fn note_events_are_sample_accurate() {
        let mut s = synth(4.0, 4);
        items(&mut s, MASTER_LIMIT, 2, 0); // no lookahead delay
        info(&mut s, env(0, E_A), 0.001, 20.0, SCALE_EXP, 0, 0.0);
        s.note_on(69, 1.0, 64);
        let (l, _) = render(&mut s, 1);
        assert!(l[..64].iter().all(|&x| x == 0.0), "silent before the offset");
        assert!(l[64..].iter().any(|&x| x != 0.0), "sounds from the offset");
        // events beyond the block carry over
        let mut s = synth(4.0, 4);
        items(&mut s, MASTER_LIMIT, 2, 0);
        s.note_on(69, 1.0, 200);
        let (l, _) = render(&mut s, 1);
        assert!(l.iter().all(|&x| x == 0.0));
        let (l, _) = render(&mut s, 1);
        assert!(l[..72].iter().all(|&x| x == 0.0) && l[72..].iter().any(|&x| x != 0.0));
    }

    #[test]
    fn link_synced_delay_and_lfo() {
        let mut s = synth(4.0, 4);
        s.params.update();
        assert!((s.delay_time() - s.params.v(DELAY_TIME)).abs() < 1e-6, "no tempo: free time");
        s.set_link(120.0, 0.0, true);
        assert!((s.delay_time() - 0.5).abs() < 1e-6, "1 beat at 120 bpm");
        items(&mut s, lfo(0, L_SYNC), 2, 1);
        items(&mut s, lfo(0, L_RETRIG), 3, 2);
        s.params.update();
        let r = lfo_rate(&s.params, 0, 0.5, 120.0, &s.divisions);
        assert!((r - 2.0).abs() < 1e-5, "1 beat at 120 bpm = 2 Hz");
    }

    #[test]
    fn ramps_reach_target_in_process() {
        let mut s = synth(4.0, 4);
        s.params.set(FILTER_CUTOFF, 0.0);
        s.params.ramp_to(FILTER_CUTOFF, 1.0, 1280, SHAPE_LINEAR);
        render(&mut s, 5);
        assert!((s.params.norm[FILTER_CUTOFF] - 0.5).abs() < 0.02);
        render(&mut s, 5);
        assert!((s.params.norm[FILTER_CUTOFF] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn no_denormals_after_release() {
        let mut s = synth(4.0, 4);
        items(&mut s, DELAY_ON, 2, 1);
        items(&mut s, REVERB_ON, 2, 1);
        items(&mut s, CHORUS_ON, 2, 1);
        s.set_link(120.0, 0.0, true);
        s.note_on(48, 1.0, 0);
        render(&mut s, 50);
        s.note_off(48, 0);
        let (l, r) = render(&mut s, 4000); // ~10 s of tails
        for x in l.iter().chain(r.iter()) {
            assert!(*x == 0.0 || x.abs() >= f32::MIN_POSITIVE, "subnormal output {}", x);
        }
        for v in &s.voices {
            for f in v.filt.iter() {
                assert!(*f == 0.0 || f.abs() >= 1e-20);
            }
        }
    }

    #[test]
    fn mono_legato_and_glide() {
        let mut s = synth(4.0, 4);
        items(&mut s, VOICE_MODE, 3, 2);
        items(&mut s, VOICE_GLIDE_MODE, 3, 1);
        render(&mut s, 1);
        s.note_on(60, 1.0, 0);
        render(&mut s, 10);
        s.note_on(67, 1.0, 0);
        render(&mut s, 1);
        assert_eq!(s.active_voices(), 1);
        assert!(s.voices[0].pitch > 60.0 && s.voices[0].pitch < 67.0, "gliding: {}", s.voices[0].pitch);
        assert_ne!(s.voices[0].env_stage[0], ST_ATTACK, "legato: no retrigger");
        s.note_off(67, 0);
        render(&mut s, 200);
        assert!((s.voices[0].pitch - 60.0).abs() < 1e-3, "back to the held note");
    }

    #[test]
    fn user_table_from_samples() {
        let mut s = synth(4.0, 4);
        let n = s.tables.len();
        let samples: Vec<f32> = (0..2048 * 3).map(|i| ((i % 2048) as f32 / 2048.0 * TWO_PI).sin()).collect();
        assert_eq!(s.load_table(n, &samples, 2048), n as i32);
        assert_eq!(s.tables.len(), n + 1);
        assert_eq!(s.tables[n].frames, 3);
        assert!(s.load_table(n + 5, &samples, 2048) < 0);
        assert!(s.load_table(n, &samples, 1000) < 0);
    }
}
