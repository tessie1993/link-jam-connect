//! Parameter table of the engine. Index layout must match `params.json` (checked by the tests).
//! Ranges and scales are not built in: the JS shell passes them from jamconnect.config.json
//! with `synth_param_info`. Values arrive normalized 0..1 and are denormalized here.

pub const OSC_COUNT: usize = 2;
pub const ENV_COUNT: usize = 3;
pub const LFO_COUNT: usize = 2;

pub const OSC_FIELDS: usize = 13;
pub const O_ON: usize = 0;
pub const O_TABLE: usize = 1;
pub const O_POS: usize = 2;
pub const O_OCT: usize = 3;
pub const O_SEMI: usize = 4;
pub const O_FINE: usize = 5;
pub const O_LEVEL: usize = 6;
pub const O_PAN: usize = 7;
pub const O_UNISON: usize = 8;
pub const O_DETUNE: usize = 9;
pub const O_SPREAD: usize = 10;
pub const O_PHASE: usize = 11;
pub const O_RAND: usize = 12;
pub const OSC_FIELD_NAMES: [&str; OSC_FIELDS] =
    ["on", "table", "pos", "oct", "semi", "fine", "level", "pan", "unison", "detune", "spread", "phase", "rand"];

pub const fn osc(o: usize, f: usize) -> usize {
    o * OSC_FIELDS + f
}

pub const SUB_LEVEL: usize = 26;
pub const SUB_OCT: usize = 27;
pub const SUB_SHAPE: usize = 28;
pub const NOISE_LEVEL: usize = 29;
pub const NOISE_COLOR: usize = 30;

pub const FILTER_ON: usize = 31;
pub const FILTER_TYPE: usize = 32;
pub const FILTER_CUTOFF: usize = 33;
pub const FILTER_RESO: usize = 34;
pub const FILTER_DRIVE: usize = 35;
pub const FILTER_KEY: usize = 36;
pub const FILTER_ENV: usize = 37;

pub const AMP_LEVEL: usize = 38;
pub const AMP_VELSENS: usize = 39;

pub const ENV_BASE: usize = 40;
pub const ENV_FIELDS: usize = 4;
pub const E_A: usize = 0;
pub const E_D: usize = 1;
pub const E_S: usize = 2;
pub const E_R: usize = 3;
pub const ENV_FIELD_NAMES: [&str; ENV_FIELDS] = ["a", "d", "s", "r"];

pub const fn env(e: usize, f: usize) -> usize {
    ENV_BASE + e * ENV_FIELDS + f
}

pub const LFO_BASE: usize = 52;
pub const LFO_FIELDS: usize = 6;
pub const L_SHAPE: usize = 0;
pub const L_RATE: usize = 1;
pub const L_SYNC: usize = 2;
pub const L_DIV: usize = 3;
pub const L_RETRIG: usize = 4;
pub const L_PHASE: usize = 5;
pub const LFO_FIELD_NAMES: [&str; LFO_FIELDS] = ["shape", "rate", "sync", "div", "retrig", "phase"];

pub const fn lfo(l: usize, f: usize) -> usize {
    LFO_BASE + l * LFO_FIELDS + f
}

pub const VOICE_MODE: usize = 64;
pub const VOICE_POLY: usize = 65;
pub const VOICE_GLIDE_MODE: usize = 66;
pub const VOICE_GLIDE: usize = 67;
pub const VOICE_BEND: usize = 68;

pub const CHORUS_ON: usize = 69;
pub const CHORUS_RATE: usize = 70;
pub const CHORUS_DEPTH: usize = 71;
pub const CHORUS_MIX: usize = 72;
pub const DELAY_ON: usize = 73;
pub const DELAY_SYNC: usize = 74;
pub const DELAY_DIV: usize = 75;
pub const DELAY_TIME: usize = 76;
pub const DELAY_FEEDBACK: usize = 77;
pub const DELAY_MIX: usize = 78;
pub const DELAY_PINGPONG: usize = 79;
pub const DELAY_TONE: usize = 80;
pub const REVERB_ON: usize = 81;
pub const REVERB_SIZE: usize = 82;
pub const REVERB_DAMP: usize = 83;
pub const REVERB_MIX: usize = 84;
pub const MASTER_GAIN: usize = 85;
pub const MASTER_LIMIT: usize = 86;
pub const MASTER_CEILING: usize = 87;

pub const FIXED_COUNT: usize = 88;
pub const MAX_MOD_SLOTS: usize = 16;
pub const MOD_FIELDS: usize = 3;
pub const M_SRC: usize = 0;
pub const M_DST: usize = 1;
pub const M_AMT: usize = 2;
pub const MOD_FIELD_NAMES: [&str; MOD_FIELDS] = ["src", "dst", "amt"];
pub const PARAM_CAPACITY: usize = FIXED_COUNT + MAX_MOD_SLOTS * MOD_FIELDS;

pub const fn mod_param(slot: usize, f: usize) -> usize {
    FIXED_COUNT + slot * MOD_FIELDS + f
}

// Modulation sources (value of modN.src).
pub const MOD_SOURCES: [&str; 12] = [
    "None", "Env 1", "Env 2", "Env 3", "LFO 1", "LFO 2", "Velocity", "Mod Wheel", "Key Track", "Aftertouch", "Random",
    "Pitch Bend",
];
pub const S_ENV1: usize = 1;
pub const S_ENV2: usize = 2;
pub const S_ENV3: usize = 3;
pub const S_LFO1: usize = 4;
pub const S_LFO2: usize = 5;
pub const S_VEL: usize = 6;
pub const S_WHEEL: usize = 7;
pub const S_KEY: usize = 8;
pub const S_AT: usize = 9;
pub const S_RAND: usize = 10;
pub const S_BEND: usize = 11;

// Modulation destinations (value of modN.dst).
pub const MOD_DESTS: [&str; 19] = [
    "None", "Osc1 Pos", "Osc2 Pos", "Pitch", "Osc1 Pitch", "Osc2 Pitch", "Osc1 Level", "Osc2 Level", "Osc1 Detune",
    "Osc2 Detune", "Sub Level", "Noise Level", "Cutoff", "Resonance", "Drive", "Amp", "Pan", "LFO1 Rate", "LFO2 Rate",
];
pub const N_DESTS: usize = 19;
pub const D_PITCH: usize = 3;
pub const D_PAN: usize = 16;
pub const D_LFO1_RATE: usize = 17;
pub const D_LFO2_RATE: usize = 18;

pub const fn d_osc_pos(o: usize) -> usize {
    1 + o
}
pub const fn d_osc_pitch(o: usize) -> usize {
    4 + o
}
pub const fn d_osc_level(o: usize) -> usize {
    6 + o
}
pub const fn d_osc_detune(o: usize) -> usize {
    8 + o
}
pub const D_SUB_LEVEL: usize = 10;
pub const D_NOISE_LEVEL: usize = 11;
pub const D_CUTOFF: usize = 12;
pub const D_RESO: usize = 13;
pub const D_DRIVE: usize = 14;
pub const D_AMP: usize = 15;

/// Parameter a matrix destination offsets (normalized), if any.
pub fn dest_param(d: usize) -> Option<usize> {
    match d {
        1 => Some(osc(0, O_POS)),
        2 => Some(osc(1, O_POS)),
        6 => Some(osc(0, O_LEVEL)),
        7 => Some(osc(1, O_LEVEL)),
        8 => Some(osc(0, O_DETUNE)),
        9 => Some(osc(1, O_DETUNE)),
        10 => Some(SUB_LEVEL),
        11 => Some(NOISE_LEVEL),
        12 => Some(FILTER_CUTOFF),
        13 => Some(FILTER_RESO),
        14 => Some(FILTER_DRIVE),
        15 => Some(AMP_LEVEL),
        17 => Some(lfo(0, L_RATE)),
        18 => Some(lfo(1, L_RATE)),
        _ => None,
    }
}

pub const SCALE_LIN: u32 = 0;
pub const SCALE_EXP: u32 = 1;
pub const SCALE_DB: u32 = 2;

pub const SHAPE_LINEAR: u32 = 0;
pub const SHAPE_STEP: u32 = 1;
pub const SHAPE_EXP: u32 = 2;
pub const SHAPE_S: u32 = 3;

#[derive(Clone, Copy, Debug)]
pub struct ParamInfo {
    pub min: f32,
    pub max: f32,
    pub scale: u32,
    pub steps: u32,
}

impl ParamInfo {
    pub const DEFAULT: ParamInfo = ParamInfo { min: 0.0, max: 1.0, scale: SCALE_LIN, steps: 0 };
}

#[derive(Clone, Copy, Debug)]
pub struct Ramp {
    pub start: f32,
    pub target: f32,
    pub total: u32,
    pub left: u32,
    pub shape: u32,
}

impl Ramp {
    pub const IDLE: Ramp = Ramp { start: 0.0, target: 0.0, total: 0, left: 0, shape: SHAPE_LINEAR };
}

/// Clamp to 0..1; NaN becomes 0.
#[inline]
pub fn clamp01(x: f32) -> f32 {
    if !(x > 0.0) {
        0.0
    } else if x > 1.0 {
        1.0
    } else {
        x
    }
}

#[inline]
pub fn db_to_amp(db: f32) -> f32 {
    libm_pow10(db / 20.0)
}

#[inline]
fn libm_pow10(x: f32) -> f32 {
    (x * core::f32::consts::LN_10).exp()
}

pub fn quantize(p: &ParamInfo, n: f32) -> f32 {
    let n = clamp01(n);
    if p.steps > 1 {
        let k = (p.steps - 1) as f32;
        (n * k).round() / k
    } else if p.steps == 1 {
        0.0
    } else {
        n
    }
}

/// norm -> value. lin: linear; exp: min*(max/min)^n; db: linear in amplitude between the two ends.
pub fn denorm(p: &ParamInfo, n: f32) -> f32 {
    let q = quantize(p, n);
    if p.steps > 1 {
        let k = (p.steps - 1) as f32;
        return p.min + (q * k).round() * (p.max - p.min) / k;
    }
    match p.scale {
        SCALE_EXP if p.min > 0.0 && p.max > 0.0 => p.min * (p.max / p.min).powf(q),
        SCALE_DB => {
            let a0 = db_to_amp(p.min);
            let a1 = db_to_amp(p.max);
            let a = a0 + q * (a1 - a0);
            if a <= 0.0 {
                p.min
            } else {
                let v = 20.0 * a.log10();
                v.max(p.min).min(p.max)
            }
        }
        _ => p.min + q * (p.max - p.min),
    }
}

/// Value of a segment from a to b at fraction x (0..1).
pub fn shape_value(shape: u32, a: f32, b: f32, x: f32) -> f32 {
    let x = clamp01(x);
    match shape {
        SHAPE_STEP => {
            if x >= 1.0 {
                b
            } else {
                a
            }
        }
        SHAPE_EXP => {
            if a.abs() > 1e-4 && b.abs() > 1e-4 && (a > 0.0) == (b > 0.0) {
                a * (b / a).powf(x)
            } else {
                a + (b - a) * x * x
            }
        }
        SHAPE_S => a + (b - a) * x * x * (3.0 - 2.0 * x),
        _ => a + (b - a) * x,
    }
}

pub struct Params {
    pub info: [ParamInfo; PARAM_CAPACITY],
    pub norm: [f32; PARAM_CAPACITY],
    pub val: [f32; PARAM_CAPACITY],
    pub ramp: [Ramp; PARAM_CAPACITY],
    dirty: [bool; PARAM_CAPACITY],
}

impl Params {
    pub fn new() -> Params {
        Params {
            info: [ParamInfo::DEFAULT; PARAM_CAPACITY],
            norm: [0.0; PARAM_CAPACITY],
            val: [0.0; PARAM_CAPACITY],
            ramp: [Ramp::IDLE; PARAM_CAPACITY],
            dirty: [true; PARAM_CAPACITY],
        }
    }

    pub fn set_info(&mut self, i: usize, info: ParamInfo) {
        if i < PARAM_CAPACITY {
            self.info[i] = info;
            self.norm[i] = quantize(&info, self.norm[i]);
            self.dirty[i] = true;
        }
    }

    pub fn set(&mut self, i: usize, n: f32) {
        if i < PARAM_CAPACITY {
            self.ramp[i].left = 0;
            self.norm[i] = quantize(&self.info[i], n);
            self.dirty[i] = true;
        }
    }

    /// Move from the current value to `target` over `frames` samples (evaluated per control block).
    pub fn ramp_to(&mut self, i: usize, target: f32, frames: u32, shape: u32) {
        if i >= PARAM_CAPACITY {
            return;
        }
        if frames == 0 {
            self.set(i, target);
            return;
        }
        self.ramp[i] = Ramp { start: self.norm[i], target: clamp01(target), total: frames, left: frames, shape };
    }

    /// Advance running ramps by n samples.
    pub fn advance(&mut self, n: u32) {
        for i in 0..PARAM_CAPACITY {
            let r = self.ramp[i];
            if r.left > 0 {
                let left = r.left.saturating_sub(n);
                self.ramp[i].left = left;
                let x = 1.0 - left as f32 / r.total as f32;
                self.norm[i] = quantize(&self.info[i], shape_value(r.shape, r.start, r.target, x));
                self.dirty[i] = true;
            }
        }
    }

    pub fn update(&mut self) {
        for i in 0..PARAM_CAPACITY {
            if self.dirty[i] {
                self.dirty[i] = false;
                self.val[i] = denorm(&self.info[i], self.norm[i]);
            }
        }
    }

    #[inline]
    pub fn v(&self, i: usize) -> f32 {
        self.val[i]
    }

    #[inline]
    pub fn vi(&self, i: usize) -> i32 {
        self.val[i].round() as i32
    }

    #[inline]
    pub fn on(&self, i: usize) -> bool {
        self.vi(i) == 1
    }

    /// Effective value with a normalized offset d.
    #[inline]
    pub fn eff(&self, i: usize, d: f32) -> f32 {
        if d == 0.0 {
            self.val[i]
        } else {
            denorm(&self.info[i], clamp01(self.norm[i] + d))
        }
    }
}

impl Default for Params {
    fn default() -> Self {
        Params::new()
    }
}

/// Wire id of a parameter index ("osc1.pos", "mod3.amt", ...).
pub fn param_name(i: usize) -> String {
    if i < 2 * OSC_FIELDS {
        return format!("osc{}.{}", i / OSC_FIELDS + 1, OSC_FIELD_NAMES[i % OSC_FIELDS]);
    }
    if (ENV_BASE..LFO_BASE).contains(&i) {
        let k = i - ENV_BASE;
        return format!("env{}.{}", k / ENV_FIELDS + 1, ENV_FIELD_NAMES[k % ENV_FIELDS]);
    }
    if (LFO_BASE..VOICE_MODE).contains(&i) {
        let k = i - LFO_BASE;
        return format!("lfo{}.{}", k / LFO_FIELDS + 1, LFO_FIELD_NAMES[k % LFO_FIELDS]);
    }
    if (FIXED_COUNT..PARAM_CAPACITY).contains(&i) {
        let k = i - FIXED_COUNT;
        return format!("mod{}.{}", k / MOD_FIELDS + 1, MOD_FIELD_NAMES[k % MOD_FIELDS]);
    }
    let s = match i {
        SUB_LEVEL => "sub.level",
        SUB_OCT => "sub.oct",
        SUB_SHAPE => "sub.shape",
        NOISE_LEVEL => "noise.level",
        NOISE_COLOR => "noise.color",
        FILTER_ON => "filter.on",
        FILTER_TYPE => "filter.type",
        FILTER_CUTOFF => "filter.cutoff",
        FILTER_RESO => "filter.reso",
        FILTER_DRIVE => "filter.drive",
        FILTER_KEY => "filter.key",
        FILTER_ENV => "filter.env",
        AMP_LEVEL => "amp.level",
        AMP_VELSENS => "amp.velSens",
        VOICE_MODE => "voice.mode",
        VOICE_POLY => "voice.poly",
        VOICE_GLIDE_MODE => "voice.glideMode",
        VOICE_GLIDE => "voice.glide",
        VOICE_BEND => "voice.bend",
        CHORUS_ON => "chorus.on",
        CHORUS_RATE => "chorus.rate",
        CHORUS_DEPTH => "chorus.depth",
        CHORUS_MIX => "chorus.mix",
        DELAY_ON => "delay.on",
        DELAY_SYNC => "delay.sync",
        DELAY_DIV => "delay.div",
        DELAY_TIME => "delay.time",
        DELAY_FEEDBACK => "delay.feedback",
        DELAY_MIX => "delay.mix",
        DELAY_PINGPONG => "delay.pingpong",
        DELAY_TONE => "delay.tone",
        REVERB_ON => "reverb.on",
        REVERB_SIZE => "reverb.size",
        REVERB_DAMP => "reverb.damp",
        REVERB_MIX => "reverb.mix",
        MASTER_GAIN => "master.gain",
        MASTER_LIMIT => "master.limit",
        MASTER_CEILING => "master.ceiling",
        _ => "?",
    };
    s.to_string()
}

/// Extract the quoted strings of a JSON array `"key": [ ... ]` (tiny parser for params.json in tests).
#[cfg(test)]
pub fn json_string_array(json: &str, key: &str) -> Vec<String> {
    let pat = format!("\"{}\"", key);
    let start = match json.find(&pat) {
        Some(s) => s + pat.len(),
        None => return Vec::new(),
    };
    let rest = &json[start..];
    let open = match rest.find('[') {
        Some(o) => o,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut inside = false;
    for ch in rest[open + 1..].chars() {
        if ch == '"' {
            if inside {
                out.push(cur.clone());
                cur.clear();
            }
            inside = !inside;
        } else if inside {
            cur.push(ch);
        } else if ch == ']' {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONTRACT: &str = include_str!("../params.json");

    #[test]
    fn fixed_ids_match_params_json() {
        let ids = json_string_array(CONTRACT, "fixed");
        assert_eq!(ids.len(), FIXED_COUNT, "params.json fixed count");
        for (i, id) in ids.iter().enumerate() {
            assert_eq!(&param_name(i), id, "param index {}", i);
        }
        assert_eq!(json_string_array(CONTRACT, "modSlotFields"), MOD_FIELD_NAMES.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert!(CONTRACT.contains(&format!("\"maxModSlots\": {}", MAX_MOD_SLOTS)));
        assert_eq!(param_name(mod_param(2, M_AMT)), "mod3.amt");
    }

    #[test]
    fn mod_lists_match_params_json() {
        assert_eq!(json_string_array(CONTRACT, "modSources"), MOD_SOURCES.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(json_string_array(CONTRACT, "modDests"), MOD_DESTS.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        // destination params point at the parameter their label names
        assert_eq!(dest_param(D_CUTOFF), Some(FILTER_CUTOFF));
        assert_eq!(dest_param(d_osc_pos(1)), Some(osc(1, O_POS)));
        assert_eq!(dest_param(D_PAN), None);
        assert_eq!(dest_param(D_LFO2_RATE), Some(lfo(1, L_RATE)));
    }

    #[test]
    fn normalization() {
        let lin = ParamInfo { min: -1.0, max: 1.0, scale: SCALE_LIN, steps: 0 };
        assert!((denorm(&lin, 0.75) - 0.5).abs() < 1e-6);
        let exp = ParamInfo { min: 20.0, max: 20000.0, scale: SCALE_EXP, steps: 0 };
        assert!((denorm(&exp, 0.5) - 632.4555).abs() < 0.01);
        let db = ParamInfo { min: -60.0, max: 6.0, scale: SCALE_DB, steps: 0 };
        assert!(denorm(&db, 0.5).abs() < 0.1, "0.5 on -60..+6 dB is ~0 dB");
        let st = ParamInfo { min: -12.0, max: 12.0, scale: SCALE_LIN, steps: 25 };
        assert_eq!(denorm(&st, 0.52), 0.0);
        assert_eq!(denorm(&st, 1.0), 12.0);
        assert_eq!(clamp01(f32::NAN), 0.0);
    }

    #[test]
    fn ramp_correctness() {
        let mut p = Params::new();
        p.set(5, 0.0);
        p.ramp_to(5, 1.0, 1000, SHAPE_LINEAR);
        p.advance(250);
        assert!((p.norm[5] - 0.25).abs() < 1e-5);
        p.advance(750);
        assert!((p.norm[5] - 1.0).abs() < 1e-6);
        p.advance(100);
        assert!((p.norm[5] - 1.0).abs() < 1e-6, "holds the target");
        p.ramp_to(6, 0.8, 100, SHAPE_STEP);
        p.advance(99);
        assert_eq!(p.norm[6], 0.0);
        p.advance(1);
        assert!((p.norm[6] - 0.8).abs() < 1e-6);
        p.set(7, 0.0);
        p.ramp_to(7, 1.0, 100, SHAPE_S);
        p.advance(50);
        assert!((p.norm[7] - 0.5).abs() < 1e-5);
        p.set(8, 0.1);
        p.ramp_to(8, 0.4, 100, SHAPE_EXP);
        p.advance(50);
        assert!((p.norm[8] - 0.2).abs() < 1e-4, "exp midpoint is the geometric mean");
    }
}
