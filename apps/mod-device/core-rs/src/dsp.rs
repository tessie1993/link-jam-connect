//! Pure modulation math: waveforms, envelopes, patterns, noise, chaos, filters, physics,
//! gestures, sensor conditioning, the route transform and curve decimation.
//! No heap allocation in anything called from the tick path.

use std::f64::consts::PI;

pub const MAX_STEPS: usize = 64;
pub const MAX_POINTERS: usize = 10;
pub const MAX_STAGES: usize = 16;

#[inline]
pub fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if v.is_nan() {
        lo
    } else if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}
#[inline]
pub fn clamp01(v: f64) -> f64 {
    clamp(v, 0.0, 1.0)
}
#[inline]
pub fn frac(x: f64) -> f64 {
    x - x.floor()
}
#[inline]
pub fn modi(a: i64, n: i64) -> i64 {
    if n <= 0 {
        0
    } else {
        ((a % n) + n) % n
    }
}
#[inline]
pub fn wrap180(d: f64) -> f64 {
    let m = (d + 180.0) % 360.0;
    (if m < 0.0 { m + 360.0 } else { m }) - 180.0
}
#[inline]
pub fn fin(v: f64, d: f64) -> f64 {
    if v.is_finite() {
        v
    } else {
        d
    }
}

/// Deterministic hash of an integer (and seed) to [0, 1): identical on every peer.
pub fn hash01(i: i64, seed: u32) -> f64 {
    let i = (i as i32) as u32;
    let mut h = (i ^ 0x9e37_79b9).wrapping_mul(0x85eb_ca6b) ^ seed.wrapping_add(0x632b_e5ab).wrapping_mul(0xc2b2_ae35);
    h ^= h >> 16;
    h = h.wrapping_mul(0x7feb_352d);
    h ^= h >> 15;
    h = h.wrapping_mul(0x846c_a68b);
    h ^= h >> 16;
    h as f64 / 4294967296.0
}

/// Seeded PRNG (mulberry32), seed handed in from JS.
#[derive(Clone, Copy)]
pub struct Rng {
    pub a: u32,
}
impl Rng {
    pub fn new(seed: u32) -> Rng {
        Rng { a: seed }
    }
    pub fn next(&mut self) -> f64 {
        self.a = self.a.wrapping_add(0x6d2b_79f5);
        let mut t = self.a;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
    pub fn gauss(&mut self) -> f64 {
        let u = self.next().max(1e-12);
        let v = self.next();
        (-2.0 * u.ln()).sqrt() * (2.0 * PI * v).cos()
    }
}

/// Curves on 0..1: 0 linear, 1 exp, 2 log, 3 s-curve, 4 step. k = curvature.
pub fn ease(curve: u32, u: f64, k: f64) -> f64 {
    let u = clamp01(u);
    match curve {
        1 => {
            if k > 0.0 {
                ((k * u).exp() - 1.0) / (k.exp() - 1.0)
            } else {
                u
            }
        }
        2 => {
            if k > 0.0 {
                1.0 - ((k * (1.0 - u)).exp() - 1.0) / (k.exp() - 1.0)
            } else {
                u
            }
        }
        3 => u * u * (3.0 - 2.0 * u),
        4 => {
            if u < 1.0 {
                0.0
            } else {
                1.0
            }
        }
        _ => u,
    }
}

/// Note-value modifier: 0 straight, 1 dotted, 2 triplet.
pub fn modifier(m: f64) -> f64 {
    match m.round() as i32 {
        1 => 1.5,
        2 => 2.0 / 3.0,
        _ => 1.0,
    }
}
/// Length in Link beats of a division given in bars (one bar = the Link quantum).
pub fn division_beats(bars: f64, m: f64, quantum: f64) -> f64 {
    bars * (if quantum > 0.0 { quantum } else { 1.0 }) * modifier(m)
}

/// Custom drawable shape: points as (x 0..1, y -1..1) pairs sorted by x; linear, wraps.
pub fn custom_shape(points: &[f64], p: f64) -> f64 {
    let n = points.len() / 2;
    if n == 0 {
        return 0.0;
    }
    if n == 1 {
        return clamp(points[1], -1.0, 1.0);
    }
    let (fx, fy) = (points[0], points[1]);
    let (lx, ly) = (points[2 * n - 2], points[2 * n - 1]);
    let ax;
    let ay;
    let bx;
    let by;
    if p < fx {
        ax = lx - 1.0;
        ay = ly;
        bx = fx;
        by = fy;
    } else if p >= lx {
        ax = lx;
        ay = ly;
        bx = fx + 1.0;
        by = fy;
    } else {
        let mut i = 1;
        while i < n && points[2 * i] <= p {
            i += 1;
        }
        ax = points[2 * i - 2];
        ay = points[2 * i - 1];
        bx = points[2 * i];
        by = points[2 * i + 1];
    }
    let span = bx - ax;
    clamp(if span > 0.0 { ay + (by - ay) * (p - ax) / span } else { by }, -1.0, 1.0)
}

/// Bipolar LFO value for a cycle position. Shapes: 0 sine, 1 tri, 2 saw, 3 ramp, 4 square,
/// 5 sample & hold, 6 smooth random, 7 custom.
pub fn lfo_shape(shape: u32, pos: f64, seed: u32, pulse_width: f64, points: &[f64]) -> f64 {
    let p = frac(pos);
    let cycle = pos.floor() as i64;
    match shape {
        0 => (2.0 * PI * p).sin(),
        1 => {
            if p < 0.25 {
                4.0 * p
            } else if p < 0.75 {
                2.0 - 4.0 * p
            } else {
                4.0 * p - 4.0
            }
        }
        2 => 2.0 * p - 1.0,
        3 => 1.0 - 2.0 * p,
        4 => {
            if p < pulse_width {
                1.0
            } else {
                -1.0
            }
        }
        5 => hash01(cycle, seed) * 2.0 - 1.0,
        6 => {
            let a = hash01(cycle, seed) * 2.0 - 1.0;
            let b = hash01(cycle + 1, seed) * 2.0 - 1.0;
            a + (b - a) * (0.5 - 0.5 * (PI * p).cos())
        }
        7 => custom_shape(points, p),
        _ => 0.0,
    }
}

#[derive(Clone, Copy, Default)]
pub struct Stage {
    pub dur: f64,
    pub level: f64,
    pub curve: u32,
}

fn run_stages(stages: &[Stage], from: usize, to: usize, level: f64, dt: f64, k: f64) -> f64 {
    let mut level = level;
    let mut dt = dt;
    let mut i = from;
    while i <= to && i < stages.len() {
        let s = stages[i];
        let dur = s.dur.max(0.0);
        if dt < dur {
            return level + (s.level - level) * ease(s.curve, dt / dur, k);
        }
        dt -= dur;
        level = s.level;
        i += 1;
    }
    level
}

/// Multi-stage envelope level at time t (beats or ms). sustain < 0 = one-shot.
/// on / off are gate times (NaN = none / still held), start = level at gate on.
pub fn env_level(stages: &[Stage], sustain: i32, on: f64, off: f64, start: f64, t: f64, k: f64) -> f64 {
    if on.is_nan() || stages.is_empty() || t.is_nan() {
        return 0.0;
    }
    if t < on {
        return start;
    }
    let last = stages.len() - 1;
    if sustain < 0 || sustain as usize >= stages.len() {
        return run_stages(stages, 0, last, start, t - on, k);
    }
    let sus = sustain as usize;
    if off.is_nan() || t < off {
        return run_stages(stages, 0, sus, start, t - on, k);
    }
    let rel = run_stages(stages, 0, sus, start, off - on, k);
    if sus + 1 > last {
        return rel;
    }
    run_stages(stages, sus + 1, last, rel, t - off, k)
}

/// Bjorklund's algorithm (Euclidean rhythm), fixed-size buffers only. Returns the pattern length.
pub fn bjorklund(pulses: usize, steps: usize, out: &mut [u8; MAX_STEPS]) -> usize {
    let steps = steps.min(MAX_STEPS);
    let pulses = pulses.min(steps);
    for o in out.iter_mut() {
        *o = 0;
    }
    if steps == 0 {
        return 0;
    }
    if pulses == 0 {
        return steps;
    }
    let mut g = [[0u8; MAX_STEPS]; MAX_STEPS];
    let mut gl = [0usize; MAX_STEPS];
    for i in 0..steps {
        g[i][0] = if i < pulses { 1 } else { 0 };
        gl[i] = 1;
    }
    let mut na = pulses;
    let mut nb = steps - pulses;
    while nb > 1 {
        let n = na.min(nb);
        let mut ng = [[0u8; MAX_STEPS]; MAX_STEPS];
        let mut ngl = [0usize; MAX_STEPS];
        for i in 0..n {
            let mut len = 0;
            for j in 0..gl[i] {
                if len < MAX_STEPS {
                    ng[i][len] = g[i][j];
                    len += 1;
                }
            }
            for j in 0..gl[na + i] {
                if len < MAX_STEPS {
                    ng[i][len] = g[na + i][j];
                    len += 1;
                }
            }
            ngl[i] = len;
        }
        let (rest_start, rest_count) = if na > n { (n, na - n) } else { (na + n, nb - n) };
        for j in 0..rest_count {
            ng[n + j] = g[rest_start + j];
            ngl[n + j] = gl[rest_start + j];
        }
        g = ng;
        gl = ngl;
        na = n;
        nb = rest_count;
    }
    let mut k = 0;
    for i in 0..(na + nb) {
        for j in 0..gl[i] {
            if k < MAX_STEPS {
                out[k] = g[i][j];
                k += 1;
            }
        }
    }
    steps
}

/// 1D gradient (Perlin) noise in [-1, 1].
pub fn perlin1(x: f64, seed: u32) -> f64 {
    let i0 = x.floor();
    let f = x - i0;
    let i0 = i0 as i64;
    let g0 = hash01(i0, seed) * 2.0 - 1.0;
    let g1 = hash01(i0 + 1, seed) * 2.0 - 1.0;
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let n0 = g0 * f;
    let n1 = g1 * (f - 1.0);
    clamp(2.0 * (n0 + (n1 - n0) * u), -1.0, 1.0)
}
pub fn fractal_noise(x: f64, octaves: f64, seed: u32) -> f64 {
    let n = (octaves.round() as i32).max(1).min(16);
    let (mut sum, mut amp, mut norm, mut fx) = (0.0, 1.0, 0.0, x);
    for o in 0..n {
        sum += amp * perlin1(fx, seed.wrapping_add((o as u32) * 101));
        norm += amp;
        amp *= 0.5;
        fx *= 2.0;
    }
    clamp(sum / norm, -1.0, 1.0)
}

/// One RK4 step of the Lorenz system.
pub fn lorenz_step(s: [f64; 3], dt: f64, sigma: f64, rho: f64, beta: f64) -> [f64; 3] {
    let f = |x: f64, y: f64, z: f64| [sigma * (y - x), x * (rho - z) - y, x * y - beta * z];
    let k1 = f(s[0], s[1], s[2]);
    let k2 = f(s[0] + k1[0] * dt / 2.0, s[1] + k1[1] * dt / 2.0, s[2] + k1[2] * dt / 2.0);
    let k3 = f(s[0] + k2[0] * dt / 2.0, s[1] + k2[1] * dt / 2.0, s[2] + k2[2] * dt / 2.0);
    let k4 = f(s[0] + k3[0] * dt, s[1] + k3[1] * dt, s[2] + k3[2] * dt);
    let mut o = [0.0; 3];
    for i in 0..3 {
        o[i] = s[i] + dt / 6.0 * (k1[i] + 2.0 * k2[i] + 2.0 * k3[i] + k4[i]);
    }
    o
}

/// Casiez et al. 1€ filter.
#[derive(Clone, Copy)]
pub struct OneEuro {
    pub min_cutoff: f64,
    pub beta: f64,
    pub d_cutoff: f64,
    x: f64,
    dx: f64,
    t: f64,
    init: bool,
}
impl OneEuro {
    pub fn new(min_cutoff: f64, beta: f64, d_cutoff: f64) -> OneEuro {
        OneEuro { min_cutoff, beta, d_cutoff, x: 0.0, dx: 0.0, t: 0.0, init: false }
    }
    pub fn reset(&mut self) {
        self.init = false;
        self.dx = 0.0;
    }
    pub fn alpha(cutoff: f64, dt: f64) -> f64 {
        if !(cutoff > 0.0) || !(dt > 0.0) {
            return 0.0;
        }
        let tau = 1.0 / (2.0 * PI * cutoff);
        1.0 / (1.0 + tau / dt)
    }
    pub fn filter(&mut self, x: f64, t_sec: f64) -> f64 {
        if !self.init {
            self.init = true;
            self.x = x;
            self.t = t_sec;
            return x;
        }
        let dt = t_sec - self.t;
        if !(dt > 0.0) {
            return self.x;
        }
        self.t = t_sec;
        let dx = (x - self.x) / dt;
        self.dx += OneEuro::alpha(self.d_cutoff, dt) * (dx - self.dx);
        let cutoff = self.min_cutoff + self.beta * self.dx.abs();
        self.x += OneEuro::alpha(cutoff, dt) * (x - self.x);
        self.x
    }
}

/// Fixed-timestep accumulator in integer microseconds: the step count never depends on frame slicing.
#[derive(Clone, Copy)]
pub struct FixedStepper {
    pub step_us: i64,
    pub max_steps: i64,
    pub acc_us: i64,
}
impl FixedStepper {
    pub fn new(step_ms: f64, max_steps: f64) -> FixedStepper {
        FixedStepper { step_us: ((fin(step_ms, 1.0) * 1000.0).round() as i64).max(1), max_steps: fin(max_steps, 0.0) as i64, acc_us: 0 }
    }
    pub fn steps(&mut self, dt_ms: f64) -> i64 {
        self.acc_us += (fin(dt_ms, 0.0).max(0.0) * 1000.0).round() as i64;
        let mut n = self.acc_us / self.step_us;
        if self.max_steps > 0 && n > self.max_steps {
            n = self.max_steps;
            self.acc_us = 0;
        } else {
            self.acc_us -= n * self.step_us;
        }
        n
    }
    pub fn dt(&self) -> f64 {
        self.step_us as f64 / 1e6
    }
}

/// Physics modes: 0 none, 1 spring, 2 inertia, 3 bounce, 4 gravity.
#[derive(Clone, Copy)]
pub struct PhysParams {
    pub mode: u32,
    pub home_x: f64,
    pub home_y: f64,
    pub spring_k: f64,
    pub damping: f64,
    pub friction: f64,
    pub restitution: f64,
    pub gravity: f64,
    pub rest_velocity: f64,
    pub rest_distance: f64,
}

/// XY puck physics with a fixed timestep (deterministic). Coordinates 0..1, y up.
#[derive(Clone, Copy)]
pub struct PadPhysics {
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    pub held: bool,
    pub rest: bool,
    pub stepper: FixedStepper,
}
impl PadPhysics {
    pub fn new(step_ms: f64, max_steps: f64) -> PadPhysics {
        PadPhysics { x: 0.5, y: 0.5, vx: 0.0, vy: 0.0, held: false, rest: true, stepper: FixedStepper::new(step_ms, max_steps) }
    }
    pub fn hold(&mut self, x: f64, y: f64, vx: f64, vy: f64) {
        self.held = true;
        self.rest = false;
        self.x = x;
        self.y = y;
        self.vx = vx;
        self.vy = vy;
        self.stepper.acc_us = 0;
    }
    pub fn release(&mut self, vx: f64, vy: f64) {
        self.held = false;
        self.rest = false;
        self.vx = fin(vx, 0.0);
        self.vy = fin(vy, 0.0);
        self.stepper.acc_us = 0;
    }
    pub fn advance(&mut self, dt_ms: f64, p: &PhysParams) {
        if self.held || self.rest {
            return;
        }
        let n = self.stepper.steps(dt_ms);
        let dt = self.stepper.dt();
        let mut i = 0;
        while i < n && !self.rest {
            self.step(dt, p);
            i += 1;
        }
    }
    pub fn step(&mut self, dt: f64, p: &PhysParams) {
        let fr = (1.0 - p.friction.max(0.0) * dt).max(0.0);
        let e = p.restitution;
        match p.mode {
            1 => {
                self.vx += (-p.spring_k * (self.x - p.home_x) - p.damping * self.vx) * dt;
                self.vy += (-p.spring_k * (self.y - p.home_y) - p.damping * self.vy) * dt;
                self.x += self.vx * dt;
                self.y += self.vy * dt;
                if self.vx.hypot(self.vy) < p.rest_velocity && (self.x - p.home_x).hypot(self.y - p.home_y) < p.rest_distance {
                    self.x = p.home_x;
                    self.y = p.home_y;
                    self.vx = 0.0;
                    self.vy = 0.0;
                    self.rest = true;
                }
            }
            2 => {
                self.vx *= fr;
                self.vy *= fr;
                self.x += self.vx * dt;
                self.y += self.vy * dt;
                if self.x < 0.0 || self.x > 1.0 {
                    self.x = clamp01(self.x);
                    self.vx = 0.0;
                }
                if self.y < 0.0 || self.y > 1.0 {
                    self.y = clamp01(self.y);
                    self.vy = 0.0;
                }
                if self.vx.hypot(self.vy) < p.rest_velocity {
                    self.vx = 0.0;
                    self.vy = 0.0;
                    self.rest = true;
                }
            }
            3 | 4 => {
                let grav = p.mode == 4;
                if grav {
                    self.vy -= p.gravity * dt;
                }
                self.vx *= fr;
                self.vy *= fr;
                self.x += self.vx * dt;
                self.y += self.vy * dt;
                if self.x < 0.0 {
                    self.x = -self.x;
                    self.vx = -self.vx * e;
                }
                if self.x > 1.0 {
                    self.x = 2.0 - self.x;
                    self.vx = -self.vx * e;
                }
                if self.y > 1.0 {
                    self.y = 2.0 - self.y;
                    self.vy = -self.vy * e;
                }
                if self.y < 0.0 {
                    self.y = -self.y;
                    self.vy = -self.vy * e;
                    if grav && self.vy.abs() < p.rest_velocity + p.gravity * dt {
                        self.y = 0.0;
                        self.vy = 0.0;
                    }
                }
                self.x = clamp01(self.x);
                self.y = clamp01(self.y);
                let on_floor = !grav || self.y <= p.rest_distance;
                if on_floor && self.vx.hypot(self.vy) < p.rest_velocity {
                    self.vx = 0.0;
                    self.vy = 0.0;
                    if grav {
                        self.y = 0.0;
                    }
                    self.rest = true;
                }
            }
            _ => {
                self.vx = 0.0;
                self.vy = 0.0;
                self.rest = true;
            }
        }
    }
}

#[derive(Clone, Copy)]
pub struct GestureCfg {
    pub max_fingers: usize,
    pub swipe_min_velocity: f64,
    pub swipe_min_distance: f64,
    pub pinch_range: f64,
    pub rotate_range_deg: f64,
    pub throw_idle_ms: f64,
    pub vf_min_cutoff: f64,
    pub vf_beta: f64,
    pub vf_d_cutoff: f64,
}

#[derive(Clone, Copy)]
pub struct Pointer {
    pub id: i32,
    pub x: f64,
    pub y: f64,
    pub x0: f64,
    pub y0: f64,
    pub lt: f64,
    pub lx: f64,
    pub ly: f64,
    pub pressure: f64,
    pub radius: f64,
}
const NO_POINTER: Pointer = Pointer { id: -1, x: 0.0, y: 0.0, x0: 0.0, y0: 0.0, lt: 0.0, lx: 0.0, ly: 0.0, pressure: f64::NAN, radius: 0.0 };

pub struct UpResult {
    pub last: bool,
    pub vx: f64,
    pub vy: f64,
    pub swipe: bool,
}

/// Multi-touch gestures for one surface: primary position (first finger), velocity, pinch, rotate, swipe.
#[derive(Clone, Copy)]
pub struct Gesture {
    pub ptrs: [Pointer; MAX_POINTERS],
    pub n: usize,
    pub primary: i32,
    pub pinch: f64,
    pub rotate: f64,
    pub swipe_x: f64,
    pub swipe_y: f64,
    pub swipe_at: f64,
    pub vx: f64,
    pub vy: f64,
    fx: OneEuro,
    fy: OneEuro,
    pair: [i32; 2],
    ps_d: f64,
    ps_pinch: f64,
    ps_rot: f64,
    ps_last_ang: f64,
    ps_acc: f64,
}
impl Gesture {
    pub fn new() -> Gesture {
        Gesture {
            ptrs: [NO_POINTER; MAX_POINTERS],
            n: 0,
            primary: -1,
            pinch: 0.0,
            rotate: 0.0,
            swipe_x: 0.0,
            swipe_y: 0.0,
            swipe_at: f64::NEG_INFINITY,
            vx: 0.0,
            vy: 0.0,
            fx: OneEuro::new(1.0, 0.0, 1.0),
            fy: OneEuro::new(1.0, 0.0, 1.0),
            pair: [-1, -1],
            ps_d: 1.0,
            ps_pinch: 0.0,
            ps_rot: 0.0,
            ps_last_ang: 0.0,
            ps_acc: 0.0,
        }
    }
    fn find(&self, id: i32) -> Option<usize> {
        for i in 0..self.n {
            if self.ptrs[i].id == id {
                return Some(i);
            }
        }
        None
    }
    fn set_filters(&mut self, c: &GestureCfg) {
        for f in [&mut self.fx, &mut self.fy] {
            f.min_cutoff = c.vf_min_cutoff;
            f.beta = c.vf_beta;
            f.d_cutoff = c.vf_d_cutoff;
        }
    }
    pub fn down(&mut self, id: i32, x: f64, y: f64, pressure: f64, radius: f64, t: f64, c: &GestureCfg) -> bool {
        if self.find(id).is_some() || self.n >= c.max_fingers.min(MAX_POINTERS) {
            return false;
        }
        self.ptrs[self.n] = Pointer { id, x, y, x0: x, y0: y, lt: t, lx: x, ly: y, pressure, radius };
        self.n += 1;
        if self.primary < 0 {
            self.primary = id;
            self.vx = 0.0;
            self.vy = 0.0;
            self.set_filters(c);
            self.fx.reset();
            self.fy.reset();
        }
        self.start_pair();
        true
    }
    pub fn moved(&mut self, id: i32, x: f64, y: f64, pressure: f64, radius: f64, t: f64, c: &GestureCfg) {
        let i = match self.find(id) {
            Some(i) => i,
            None => return,
        };
        let p = self.ptrs[i];
        if id == self.primary && t > p.lt {
            let dt = (t - p.lt) / 1000.0;
            self.set_filters(c);
            self.vx = self.fx.filter((x - p.lx) / dt, t / 1000.0);
            self.vy = self.fy.filter((y - p.ly) / dt, t / 1000.0);
        }
        let q = &mut self.ptrs[i];
        q.x = x;
        q.y = y;
        q.lx = x;
        q.ly = y;
        q.lt = t;
        q.pressure = pressure;
        q.radius = radius;
        self.update_pair(c);
    }
    pub fn up(&mut self, id: i32, t: f64, c: &GestureCfg) -> Option<UpResult> {
        let i = self.find(id)?;
        let p = self.ptrs[i];
        for j in i..self.n - 1 {
            self.ptrs[j] = self.ptrs[j + 1];
        }
        self.n -= 1;
        self.ptrs[self.n] = NO_POINTER;
        if self.pair[0] == id || self.pair[1] == id {
            self.pair = [-1, -1];
        }
        self.start_pair();
        if id == self.primary {
            if self.n > 0 {
                self.primary = self.ptrs[0].id;
                let q = &mut self.ptrs[0];
                q.lt = t;
                q.lx = q.x;
                q.ly = q.y;
                self.fx.reset();
                self.fy.reset();
            } else {
                self.primary = -1;
            }
        }
        if self.n > 0 {
            return Some(UpResult { last: false, vx: 0.0, vy: 0.0, swipe: false });
        }
        let idle = t - p.lt > c.throw_idle_ms;
        let (vx, vy) = if idle { (0.0, 0.0) } else { (self.vx, self.vy) };
        let dx = p.x - p.x0;
        let dy = p.y - p.y0;
        let speed = vx.hypot(vy);
        let dist = dx.hypot(dy);
        let mut swipe = false;
        if speed >= c.swipe_min_velocity && dist >= c.swipe_min_distance && dist > 0.0 {
            swipe = true;
            self.swipe_x = clamp(dx / dist, -1.0, 1.0);
            self.swipe_y = clamp(dy / dist, -1.0, 1.0);
            self.swipe_at = t;
        }
        Some(UpResult { last: true, vx, vy, swipe })
    }
    pub fn primary_ptr(&self) -> Option<Pointer> {
        if self.n > 0 {
            Some(self.ptrs[0])
        } else {
            None
        }
    }
    fn start_pair(&mut self) {
        if self.pair[0] >= 0 || self.n < 2 {
            return;
        }
        let a = self.ptrs[0];
        let b = self.ptrs[1];
        self.pair = [a.id, b.id];
        self.ps_d = (b.x - a.x).hypot(b.y - a.y).max(1e-6);
        self.ps_pinch = self.pinch;
        self.ps_rot = self.rotate;
        self.ps_last_ang = (b.y - a.y).atan2(b.x - a.x);
        self.ps_acc = 0.0;
    }
    fn update_pair(&mut self, c: &GestureCfg) {
        if self.pair[0] < 0 {
            return;
        }
        let (ia, ib) = match (self.find(self.pair[0]), self.find(self.pair[1])) {
            (Some(a), Some(b)) => (a, b),
            _ => return,
        };
        let a = self.ptrs[ia];
        let b = self.ptrs[ib];
        let d = (b.x - a.x).hypot(b.y - a.y).max(1e-6);
        let range = c.pinch_range.max(1.0001);
        self.pinch = clamp(self.ps_pinch + (d / self.ps_d).ln() / range.ln(), -1.0, 1.0);
        let ang = (b.y - a.y).atan2(b.x - a.x);
        self.ps_acc += wrap180((ang - self.ps_last_ang) * 180.0 / PI);
        self.ps_last_ang = ang;
        let rr = if c.rotate_range_deg > 0.0 { c.rotate_range_deg } else { 180.0 };
        self.rotate = clamp(self.ps_rot + self.ps_acc / rr, -1.0, 1.0);
    }
}

#[derive(Clone, Copy)]
pub struct MotionParams {
    pub tilt_range: f64,
    pub accel_range: f64,
    pub rot_range: f64,
    pub dead_zone: f64,
    pub min_cutoff: f64,
    pub filter_beta: f64,
    pub d_cutoff: f64,
}

/// Sensor conditioning: calibration zero, inversion, dead zone, range, 1€ smoothing, shake detection.
/// Channel indexes follow the motion source outputs (0 alpha .. 9 rotG).
#[derive(Clone, Copy)]
pub struct Motion {
    pub zero: [f64; 3],
    pub raw: [f64; 3],
    pub invert: [bool; 10],
    pub filters: [OneEuro; 10],
    pub gravity: [f64; 3],
    pub has_gravity: bool,
    pub gravity_t: f64,
    pub last_shake: f64,
}
impl Motion {
    pub fn new() -> Motion {
        Motion {
            zero: [0.0; 3],
            raw: [0.0; 3],
            invert: [false; 10],
            filters: [OneEuro::new(1.0, 0.0, 1.0); 10],
            gravity: [0.0; 3],
            has_gravity: false,
            gravity_t: 0.0,
            last_shake: f64::NEG_INFINITY,
        }
    }
    pub fn calibrate(&mut self) {
        self.zero = self.raw;
        for f in self.filters.iter_mut() {
            f.reset();
        }
    }
    pub fn shape(&self, ch: usize, v: f64, range: f64, p: &MotionParams) -> f64 {
        let mut n = clamp(v / if range > 0.0 { range } else { 1.0 }, -1.0, 1.0);
        let dz = clamp(p.dead_zone, 0.0, 0.99);
        n = if n.abs() <= dz { 0.0 } else { n.signum() * (n.abs() - dz) / (1.0 - dz) };
        if self.invert[ch] {
            -n
        } else {
            n
        }
    }
    pub fn filt(&mut self, ch: usize, v: f64, t_ms: f64, p: &MotionParams) -> f64 {
        let f = &mut self.filters[ch];
        f.min_cutoff = p.min_cutoff;
        f.beta = p.filter_beta;
        f.d_cutoff = p.d_cutoff;
        f.filter(v, t_ms / 1000.0)
    }
    /// raw orientation in degrees (NaN = missing) -> out[0..3]; returns a mask of written channels.
    pub fn orientation(&mut self, raw: [f64; 3], t_ms: f64, p: &MotionParams, out: &mut [f64]) -> u32 {
        let mut mask = 0;
        for k in 0..3 {
            if !raw[k].is_finite() {
                continue;
            }
            self.raw[k] = raw[k];
            let rel = if k == 2 { raw[k] - self.zero[k] } else { wrap180(raw[k] - self.zero[k]) };
            let s = self.shape(k, rel, p.tilt_range, p);
            out[k] = self.filt(k, s, t_ms, p);
            mask |= 1 << k;
        }
        mask
    }
    /// Linear acceleration (m/s², NaN if missing) or acceleration including gravity -> out[3..7].
    /// Returns true when a shake fired.
    pub fn accel(&mut self, lin: [f64; 3], with_g: [f64; 3], t_ms: f64, p: &MotionParams, lowpass_hz: f64, shake_threshold: f64, refractory_ms: f64, out: &mut [f64]) -> bool {
        let mut acc = lin;
        if !(lin[0].is_finite() && lin[1].is_finite() && lin[2].is_finite()) {
            if !(with_g[0].is_finite() && with_g[1].is_finite() && with_g[2].is_finite()) {
                return false;
            }
            if !self.has_gravity {
                self.gravity = with_g;
                self.gravity_t = t_ms;
                self.has_gravity = true;
            }
            let dt = ((t_ms - self.gravity_t) / 1000.0).max(1e-6);
            let a = OneEuro::alpha(lowpass_hz, dt);
            for k in 0..3 {
                self.gravity[k] += a * (with_g[k] - self.gravity[k]);
                acc[k] = with_g[k] - self.gravity[k];
            }
            self.gravity_t = t_ms;
        }
        for k in 0..3 {
            let s = self.shape(3 + k, acc[k], p.accel_range, p);
            out[3 + k] = self.filt(3 + k, s, t_ms, p);
        }
        let mag = (acc[0] * acc[0] + acc[1] * acc[1] + acc[2] * acc[2]).sqrt();
        out[6] = clamp01(mag / if p.accel_range > 0.0 { p.accel_range } else { 1.0 });
        if mag >= shake_threshold && t_ms - self.last_shake >= refractory_ms {
            self.last_shake = t_ms;
            return true;
        }
        false
    }
    /// Rotation rate in °/s -> out[7..10].
    pub fn rotation(&mut self, r: [f64; 3], t_ms: f64, p: &MotionParams, out: &mut [f64]) {
        for k in 0..3 {
            if r[k].is_finite() {
                let s = self.shape(7 + k, r[k], p.rot_range, p);
                out[7 + k] = self.filt(7 + k, s, t_ms, p);
            }
        }
    }
}

/// Route transform settings. curve: 0 lin, 1 exp, 2 log, 3 s. polarity: 0 auto, 1 uni, 2 bi.
#[derive(Clone, Copy)]
pub struct Tf {
    pub depth: f64,
    pub offset: f64,
    pub curve: u32,
    pub curve_amount: f64,
    pub slew_ms: f64,
    pub steps: f64,
    pub invert: bool,
    pub polarity: u32,
}
impl Tf {
    pub fn new() -> Tf {
        Tf { depth: 1.0, offset: 0.0, curve: 0, curve_amount: 1.0, slew_ms: 0.0, steps: 0.0, invert: false, polarity: 0 }
    }
}

/// Source value (own polarity) -> 0..1 -> invert -> response curve -> quantize ->
/// absolute (0..1: offset + depth * u) or offset (-1..1: offset + depth * b, b = 2u - 1 for bipolar,
/// u for unipolar) -> slew (full range in slew_ms). state: slew memory (NaN = fresh), or None.
pub fn apply_transform(raw: f64, in_bi: bool, offset_mode: bool, tf: &Tf, state: Option<&mut f64>, dt_ms: f64) -> f64 {
    let mut u = if in_bi { (clamp(raw, -1.0, 1.0) + 1.0) / 2.0 } else { clamp01(raw) };
    if tf.invert {
        u = 1.0 - u;
    }
    if tf.curve != 0 {
        u = ease(tf.curve, u, tf.curve_amount);
    }
    if tf.steps >= 2.0 {
        let n = tf.steps.round() - 1.0;
        u = (u * n).round() / n;
    }
    let bi = match tf.polarity {
        1 => false,
        2 => true,
        _ => in_bi,
    };
    let mut out = if offset_mode {
        clamp(tf.offset + tf.depth * if bi { 2.0 * u - 1.0 } else { u }, -1.0, 1.0)
    } else {
        clamp01(tf.offset + tf.depth * u)
    };
    if let Some(st) = state {
        if tf.slew_ms > 0.0 && st.is_finite() {
            let max_step = (if offset_mode { 2.0 } else { 1.0 }) * dt_ms.max(0.0) / tf.slew_ms;
            *st += clamp(out - *st, -max_step, max_step);
            out = *st;
        } else {
            *st = out;
        }
    }
    out
}

#[derive(Clone, Copy, Default, Debug)]
pub struct Pt {
    pub beat: f64,
    pub value: f64,
}

/// Error-bounded decimation (Ramer-Douglas-Peucker on the value axis). keep[i] = 1 for kept points.
/// stack needs room for points.len() + 1 entries. Every input point stays within tol of the kept polyline.
pub fn decimate(points: &[Pt], tol: f64, keep: &mut [u8], stack: &mut [(usize, usize)]) -> usize {
    let n = points.len().min(keep.len());
    for k in keep.iter_mut().take(n) {
        *k = 0;
    }
    if n == 0 {
        return 0;
    }
    keep[0] = 1;
    keep[n - 1] = 1;
    if n <= 2 {
        return n;
    }
    let mut top = 0;
    stack[top] = (0, n - 1);
    top += 1;
    while top > 0 {
        top -= 1;
        let (a, b) = stack[top];
        let pa = points[a];
        let pb = points[b];
        let span = pb.beat - pa.beat;
        let mut max_e = -1.0;
        let mut idx = 0;
        let mut i = a + 1;
        while i < b {
            let p = points[i];
            let v = if span > 0.0 { pa.value + (pb.value - pa.value) * (p.beat - pa.beat) / span } else { pa.value };
            let e = (p.value - v).abs();
            if e > max_e {
                max_e = e;
                idx = i;
            }
            i += 1;
        }
        if idx > 0 && max_e > tol && top + 2 <= stack.len() {
            keep[idx] = 1;
            stack[top] = (a, idx);
            stack[top + 1] = (idx, b);
            top += 2;
        }
    }
    keep.iter().take(n).filter(|k| **k == 1).count()
}

/// Step curves: keep points where the value changes, and the last one.
pub fn decimate_steps(points: &[Pt], tol: f64, keep: &mut [u8]) -> usize {
    let n = points.len().min(keep.len());
    let mut last = f64::NAN;
    let mut count = 0;
    for i in 0..n {
        let k = last.is_nan() || (points[i].value - last).abs() > tol || i == n - 1;
        keep[i] = if k { 1 } else { 0 };
        if k {
            last = points[i].value;
            count += 1;
        }
    }
    count
}

/// Max |error| of samples against the polyline through the kept points (tests / diagnostics).
pub fn polyline_error(samples: &[Pt], keep: &[u8]) -> f64 {
    let mut worst: f64 = 0.0;
    let mut a = 0usize;
    for i in 0..samples.len() {
        if keep[i] == 1 {
            a = i;
            continue;
        }
        let mut b = i + 1;
        while b < samples.len() && keep[b] == 0 {
            b += 1;
        }
        if b >= samples.len() {
            b = samples.len() - 1;
        }
        let pa = samples[a];
        let pb = samples[b];
        let span = pb.beat - pa.beat;
        let v = if span > 0.0 { pa.value + (pb.value - pa.value) * (samples[i].beat - pa.beat) / span } else { pa.value };
        worst = worst.max((v - samples[i].value).abs());
    }
    worst
}

/// Value at a beat of received breakpoints (beat, norm, shape) triples; shape 0 linear, 1 step,
/// 2 exp, 3 s. Holds before / after. NaN if empty.
pub fn curve_value_at(points: &[f64], beat: f64, k: f64) -> f64 {
    let n = points.len() / 3;
    if n == 0 {
        return f64::NAN;
    }
    if beat <= points[0] {
        return points[1];
    }
    for i in 1..n {
        let (bb, bn, shape) = (points[3 * i], points[3 * i + 1], points[3 * i + 2]);
        if beat < bb {
            let (ab, an) = (points[3 * i - 3], points[3 * i - 2]);
            let u = (beat - ab) / (bb - ab).max(1e-12);
            return match shape.round() as i32 {
                1 => an,
                2 => an + (bn - an) * ease(1, u, k),
                3 => an + (bn - an) * ease(3, u, k),
                _ => an + (bn - an) * u,
            };
        }
    }
    points[3 * n - 2]
}

/// Parameter range for normalized modulation of a real-valued parameter.
#[derive(Clone, Copy, Default)]
pub struct ParamDef {
    pub min: f64,
    pub max: f64,
    pub exp: bool,
    pub steps: f64,
}
pub fn real_to_norm(d: &ParamDef, v: f64) -> f64 {
    if d.max == d.min {
        return 0.0;
    }
    if d.exp && d.min > 0.0 && d.max > 0.0 && v > 0.0 {
        return clamp01((v / d.min).ln() / (d.max / d.min).ln());
    }
    clamp01((v - d.min) / (d.max - d.min))
}
pub fn norm_to_real(d: &ParamDef, n: f64) -> f64 {
    let n = clamp01(n);
    let mut v = if d.exp && d.min > 0.0 && d.max > 0.0 { d.min * (d.max / d.min).powf(n) } else { d.min + n * (d.max - d.min) };
    if d.steps > 1.0 && d.max != d.min {
        let span = d.max - d.min;
        v = d.min + ((v - d.min) / span * (d.steps - 1.0)).round() * span / (d.steps - 1.0);
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pat(p: usize, s: usize) -> String {
        let mut o = [0u8; MAX_STEPS];
        let n = bjorklund(p, s, &mut o);
        o[..n].iter().map(|v| if *v == 1 { 'x' } else { '.' }).collect()
    }

    #[test]
    fn euclidean_patterns() {
        assert_eq!(pat(3, 8), "x..x..x.");
        assert_eq!(pat(5, 8), "x.xx.xx.");
        assert_eq!(pat(4, 16), "x...x...x...x...");
        assert_eq!(pat(0, 5), ".....");
        assert_eq!(pat(7, 7), "xxxxxxx");
        assert_eq!(pat(9, 4), "xxxx");
        assert_eq!(pat(5, 13).matches('x').count(), 5);
        assert_eq!(pat(3, 0), "");
    }

    #[test]
    fn envelope_stages() {
        let st = [Stage { dur: 1.0, level: 1.0, curve: 0 }, Stage { dur: 1.0, level: 0.5, curve: 0 }, Stage { dur: 2.0, level: 0.0, curve: 0 }];
        let l = |t: f64, off: f64| env_level(&st, 1, 0.0, off, 0.0, t, 4.0);
        let nan = f64::NAN;
        assert!((l(0.5, nan) - 0.5).abs() < 1e-12);
        assert!((l(1.0, nan) - 1.0).abs() < 1e-12);
        assert!((l(1.5, nan) - 0.75).abs() < 1e-12);
        assert!((l(100.0, nan) - 0.5).abs() < 1e-12);
        assert!((l(5.0, 4.0) - 0.25).abs() < 1e-12);
        assert!(l(9.0, 4.0).abs() < 1e-12);
        assert!((l(1.5, 0.5) - 0.25).abs() < 1e-12, "release from the attack level");
        assert!((env_level(&st, -1, 0.0, nan, 0.0, 3.0, 4.0) - 0.25).abs() < 1e-12, "one-shot");
        assert_eq!(env_level(&st, 1, nan, nan, 0.0, 3.0, 4.0), 0.0);
        let ah = [Stage { dur: 1.0, level: 1.0, curve: 0 }, Stage { dur: 2.0, level: 1.0, curve: 0 }, Stage { dur: 1.0, level: 0.2, curve: 0 }, Stage { dur: 1.0, level: 0.0, curve: 0 }];
        assert!((env_level(&ah, 2, 0.0, nan, 0.0, 2.5, 4.0) - 1.0).abs() < 1e-12);
        assert!((env_level(&ah, 2, 0.0, nan, 0.0, 3.5, 4.0) - 0.6).abs() < 1e-12);
        assert!(ease(1, 0.5, 4.0) < 0.5 && ease(2, 0.5, 4.0) > 0.5 && (ease(3, 0.5, 0.0) - 0.5).abs() < 1e-12);
    }

    #[test]
    fn lfo_shapes() {
        assert!((lfo_shape(1, 0.25, 0, 0.5, &[]) - 1.0).abs() < 1e-12);
        assert!((lfo_shape(1, 0.75, 0, 0.5, &[]) + 1.0).abs() < 1e-12);
        assert_eq!(lfo_shape(4, 0.2, 0, 0.25, &[]), 1.0);
        assert_eq!(lfo_shape(4, 0.3, 0, 0.25, &[]), -1.0);
        let pts = [0.0, -1.0, 0.5, 1.0];
        assert!(lfo_shape(7, 0.25, 0, 0.5, &pts).abs() < 1e-12);
        assert!(lfo_shape(7, 0.75, 0, 0.5, &pts).abs() < 1e-12);
        for c in 0..50 {
            let a = lfo_shape(5, c as f64 + 0.1, 4, 0.5, &[]);
            assert_eq!(a, lfo_shape(5, c as f64 + 0.9, 4, 0.5, &[]));
            assert!((-1.0..=1.0).contains(&a));
            let s = lfo_shape(6, c as f64 + 0.37, 4, 0.5, &[]);
            assert!((-1.0..=1.0).contains(&s));
        }
        assert!((division_beats(0.25, 0.0, 4.0) - 1.0).abs() < 1e-12);
        assert!((division_beats(0.125, 2.0, 4.0) - 1.0 / 3.0).abs() < 1e-12);
        assert!((division_beats(0.5, 1.0, 4.0) - 3.0).abs() < 1e-12);
    }

    #[test]
    fn one_euro_filter() {
        let mut f = OneEuro::new(1.0, 0.0, 1.0);
        let mut y = 0.0;
        for i in 0..200 {
            y = f.filter(0.42, i as f64 / 100.0);
        }
        assert!((y - 0.42).abs() < 1e-12);
        let mut rng = Rng::new(5);
        let noisy: Vec<f64> = (0..600).map(|_| 0.5 + (rng.next() - 0.5) * 0.2).collect();
        let mut f2 = OneEuro::new(1.0, 0.0, 1.0);
        let out: Vec<f64> = noisy.iter().enumerate().map(|(i, v)| f2.filter(*v, i as f64 / 60.0)).collect();
        let var = |a: &[f64]| {
            let m = a.iter().sum::<f64>() / a.len() as f64;
            a.iter().map(|v| (v - m) * (v - m)).sum::<f64>() / a.len() as f64
        };
        assert!(var(&out[100..]) < var(&noisy[100..]) / 5.0);
        let lag = |beta: f64| {
            let mut f = OneEuro::new(1.0, beta, 1.0);
            let mut v = 0.0;
            for i in 0..=60 {
                v = f.filter(i as f64 / 10.0, i as f64 / 60.0);
            }
            6.0 - v
        };
        assert!(lag(1.0) < lag(0.0) / 2.0);
    }

    fn phys(mode: u32) -> PhysParams {
        PhysParams { mode, home_x: 0.5, home_y: 0.5, spring_k: 80.0, damping: 10.0, friction: 1.5, restitution: 0.75, gravity: 6.0, rest_velocity: 0.02, rest_distance: 0.002 }
    }

    #[test]
    fn physics_determinism() {
        for mode in 1..=4u32 {
            let run = |frames: &[f64]| {
                let mut ph = PadPhysics::new(2.0, 200.0);
                ph.hold(0.9, 0.1, 0.0, 0.0);
                ph.release(3.1, -2.2);
                for f in frames {
                    ph.advance(*f, &phys(mode));
                }
                ph
            };
            let a_frames: Vec<f64> = (0..240).map(|_| 1000.0 / 60.0).collect();
            let mut b_frames = Vec::new();
            let mut left = 4000.0f64;
            let mut rng = Rng::new(9);
            while left > 0.0 {
                let f = left.min(((1.0 + rng.next() * 30.0) * 1000.0).round() / 1000.0);
                b_frames.push(f);
                left = ((left - f) * 1000.0).round() / 1000.0;
            }
            let a = run(&a_frames);
            let b = run(&b_frames);
            assert_eq!((a.x, a.y, a.vx, a.vy), (b.x, b.y, b.vx, b.vy), "mode {}", mode);
            assert!(a.x >= 0.0 && a.x <= 1.0 && a.y >= 0.0 && a.y <= 1.0);
        }
        let mut sp = PadPhysics::new(2.0, 200.0);
        sp.hold(0.9, 0.1, 0.0, 0.0);
        sp.release(1.0, 1.0);
        for _ in 0..600 {
            sp.advance(10.0, &phys(1));
        }
        assert!(sp.rest && sp.x == 0.5 && sp.y == 0.5);
        let mut g = PadPhysics::new(2.0, 200.0);
        g.hold(0.5, 0.9, 0.0, 0.0);
        g.release(0.3, 0.0);
        for _ in 0..1000 {
            g.advance(10.0, &phys(4));
        }
        assert!(g.rest && g.y == 0.0);
    }

    #[test]
    fn chaos_and_noise_bounded() {
        let mut s = [0.1, 0.0, 0.0];
        for _ in 0..200000 {
            s = lorenz_step(s, 0.01, 10.0, 28.0, 8.0 / 3.0);
        }
        assert!(s.iter().all(|v| v.is_finite() && v.abs() < 100.0));
        let mut x = 0.4f64;
        for _ in 0..100000 {
            x = 4.0 * x * (1.0 - x);
            assert!((0.0..=1.0).contains(&x));
        }
        let mut m: f64 = 0.0;
        let mut t = -50.0;
        while t < 50.0 {
            m = m.max(perlin1(t, 3).abs()).max(fractal_noise(t, 4.0, 3).abs());
            t += 0.013;
        }
        assert!(m <= 1.0 && m > 0.3);
    }

    #[test]
    fn transform_chain() {
        let tf = Tf { depth: 1.0, offset: 0.0, curve: 0, curve_amount: 3.0, slew_ms: 0.0, steps: 0.0, invert: false, polarity: 0 };
        let t = |raw: f64, bi: bool, off: bool, f: Tf| apply_transform(raw, bi, off, &f, None, 0.0);
        assert!((t(0.0, true, false, tf) - 0.5).abs() < 1e-12);
        assert!((t(1.0, false, false, Tf { depth: 0.5, offset: 0.25, ..tf }) - 0.75).abs() < 1e-12);
        assert!((t(0.2, false, false, Tf { invert: true, ..tf }) - 0.8).abs() < 1e-12);
        assert!((t(0.5, false, false, Tf { curve: 1, ..tf }) - ease(1, 0.5, 3.0)).abs() < 1e-12);
        assert!((t(0.4, false, false, Tf { steps: 3.0, ..tf }) - 0.5).abs() < 1e-12);
        assert!((t(-1.0, true, true, Tf { depth: 0.5, ..tf }) + 0.5).abs() < 1e-12);
        assert!((t(1.0, false, true, Tf { depth: -0.8, ..tf }) + 0.8).abs() < 1e-12);
        assert!(t(0.0, false, true, Tf { depth: -0.8, ..tf }).abs() < 1e-12);
        assert!((t(0.0, false, true, Tf { polarity: 2, ..tf }) + 1.0).abs() < 1e-12);
        let mut st = f64::NAN;
        let s = Tf { slew_ms: 100.0, ..tf };
        apply_transform(0.0, false, false, &s, Some(&mut st), 0.0);
        let a = apply_transform(1.0, false, false, &s, Some(&mut st), 25.0);
        let b = apply_transform(1.0, false, false, &s, Some(&mut st), 100.0);
        assert!((a - 0.25).abs() < 1e-12 && (b - 1.0).abs() < 1e-12);
    }

    #[test]
    fn decimation_error_bound() {
        let tol = 0.004;
        let mut rng = Rng::new(21);
        let mut kept_ratio = 0.0;
        for k in 0..20 {
            let mut v = 0.5;
            let pts: Vec<Pt> = (0..300)
                .map(|i| {
                    v = clamp01(v + (rng.next() - 0.5) * 0.02);
                    Pt { beat: i as f64 * 0.01, value: if k % 2 == 1 { v } else { 0.5 + 0.5 * (i as f64 / 20.0).sin() } }
                })
                .collect();
            let mut keep = vec![0u8; pts.len()];
            let mut stack = vec![(0usize, 0usize); pts.len() + 1];
            let n = decimate(&pts, tol, &mut keep, &mut stack);
            assert!(polyline_error(&pts, &keep) <= tol + 1e-12);
            assert!(keep[0] == 1 && keep[pts.len() - 1] == 1);
            kept_ratio += n as f64 / pts.len() as f64;
        }
        assert!(kept_ratio / 20.0 < 0.5);
        let sp: Vec<Pt> = [0.0, 0.0, 0.0, 1.0, 1.0, 0.5, 0.5].iter().enumerate().map(|(i, v)| Pt { beat: i as f64, value: *v }).collect();
        let mut keep = vec![0u8; sp.len()];
        assert_eq!(decimate_steps(&sp, 1e-6, &mut keep), 4);
        assert_eq!(keep, vec![1, 0, 0, 1, 0, 1, 1]);
    }

    #[test]
    fn gestures_and_motion() {
        let c = GestureCfg { max_fingers: 5, swipe_min_velocity: 1.5, swipe_min_distance: 0.15, pinch_range: 4.0, rotate_range_deg: 180.0, throw_idle_ms: 60.0, vf_min_cutoff: 2.0, vf_beta: 0.1, vf_d_cutoff: 1.0 };
        let mut g = Gesture::new();
        g.down(1, 0.4, 0.5, f64::NAN, 10.0, 0.0, &c);
        g.down(2, 0.6, 0.5, f64::NAN, 10.0, 0.0, &c);
        g.moved(2, 0.4 + 0.2 * 4.0, 0.5, f64::NAN, 10.0, 16.0, &c);
        assert!((g.pinch - 1.0).abs() < 1e-9);
        let mut g3 = Gesture::new();
        g3.down(1, 0.1, 0.5, f64::NAN, 10.0, 0.0, &c);
        for i in 1..=10 {
            g3.moved(1, 0.1 + i as f64 * 0.06, 0.5, f64::NAN, 10.0, i as f64 * 10.0, &c);
        }
        let up = g3.up(1, 101.0, &c).unwrap();
        assert!(up.last && up.swipe && g3.swipe_x > 0.99);
        let mut m = Motion::new();
        let p = MotionParams { tilt_range: 45.0, accel_range: 10.0, rot_range: 360.0, dead_zone: 0.1, min_cutoff: 1000.0, filter_beta: 0.0, d_cutoff: 1.0 };
        let mut out = [0.0; 11];
        m.orientation([350.0, 10.0, 5.0], 0.0, &p, &mut out);
        m.calibrate();
        m.orientation([10.0, 32.5, 5.0], 1000.0, &p, &mut out);
        assert!((out[1] - (22.5 / 45.0 - 0.1) / 0.9).abs() < 1e-3);
        assert!((out[0] - (20.0 / 45.0 - 0.1) / 0.9).abs() < 1e-3);
        assert_eq!(out[2], 0.0);
        let mut shakes = 0;
        let mut t = 0.0;
        while t < 1000.0 {
            let v = if ((t / 20.0) as i64) % 2 == 1 { 15.0 } else { 0.0 };
            if m.accel([v, 0.0, 0.0], [f64::NAN; 3], t, &p, 0.8, 14.0, 350.0, &mut out) {
                shakes += 1;
            }
            t += 20.0;
        }
        assert!((2..=3).contains(&shakes));
    }

    #[test]
    fn curves_received() {
        let pts = [0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 2.0, 0.0, 1.0];
        assert!((curve_value_at(&pts, 0.5, 4.0) - 0.5).abs() < 1e-12);
        assert_eq!(curve_value_at(&pts, 1.5, 4.0), 1.0);
        assert_eq!(curve_value_at(&pts, 5.0, 4.0), 0.0);
        assert!(curve_value_at(&[], 1.0, 4.0).is_nan());
        let d = ParamDef { min: 20.0, max: 20000.0, exp: true, steps: 0.0 };
        assert!((norm_to_real(&d, real_to_norm(&d, 1000.0)) - 1000.0).abs() < 1e-6);
    }
}
