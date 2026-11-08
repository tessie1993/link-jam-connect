//! Engine configuration, passed from jamconnect.config.json (client.synth) as a flat f32 array in the
//! order of CONFIG_KEYS (= params.json "config"). Nothing tunable is built into the engine; the
//! `.max(...)` guards only keep a malformed config from producing NaN or a division by zero.

pub const REVERB_LINES: usize = 8;
pub const REVERB_DIFFUSERS: usize = 4;

pub const CONFIG_KEYS: [&str; 47] = [
    "engine.maxPolyphony", "engine.maxUnison", "engine.controlBlock", "engine.stealFadeMs", "engine.voiceKillDb",
    "engine.envCurveEpsilon", "engine.velocityCurve", "engine.filterEnvOctaves", "engine.filterMinHz", "engine.filterMaxRatio",
    "engine.filterMaxResonance", "engine.driveThresholdDb", "engine.modPitchSemis", "engine.keytrackCenterNote", "engine.keytrackSpanSemis",
    "engine.noiseTiltCoef", "engine.tuningA4", "engine.chorusBaseMs", "engine.chorusDepthMs", "engine.delayMaxSec",
    "engine.delaySmoothMs", "engine.reverbMinDecaySec", "engine.reverbMaxDecaySec", "engine.reverbDampMax", "engine.reverbDiffusion",
    "engine.reverbDelaysMs[0]", "engine.reverbDelaysMs[1]", "engine.reverbDelaysMs[2]", "engine.reverbDelaysMs[3]",
    "engine.reverbDelaysMs[4]", "engine.reverbDelaysMs[5]", "engine.reverbDelaysMs[6]", "engine.reverbDelaysMs[7]",
    "engine.reverbDiffusersMs[0]", "engine.reverbDiffusersMs[1]", "engine.reverbDiffusersMs[2]", "engine.reverbDiffusersMs[3]",
    "engine.limiterLookaheadMs", "engine.limiterReleaseMs", "engine.gainSmoothMs",
    "wavetable.frames", "wavetable.baseHarmonics", "wavetable.oversample", "wavetable.minTableSize", "wavetable.maxFrames",
    "wavetable.maxTables", "engine.randomSeed",
];

#[derive(Clone, Copy, Debug)]
pub struct Cfg {
    pub max_polyphony: usize,
    pub max_unison: usize,
    pub control_block: usize,
    pub steal_fade_ms: f32,
    pub voice_kill_db: f32,
    pub env_curve_epsilon: f32,
    pub velocity_curve: f32,
    pub filter_env_octaves: f32,
    pub filter_min_hz: f32,
    pub filter_max_ratio: f32,
    pub filter_max_resonance: f32,
    pub drive_threshold_db: f32,
    pub mod_pitch_semis: f32,
    pub keytrack_center: f32,
    pub keytrack_span: f32,
    pub noise_tilt: f32,
    pub tuning_a4: f32,
    pub chorus_base_ms: f32,
    pub chorus_depth_ms: f32,
    pub delay_max_sec: f32,
    pub delay_smooth_ms: f32,
    pub reverb_min_decay: f32,
    pub reverb_max_decay: f32,
    pub reverb_damp_max: f32,
    pub reverb_diffusion: f32,
    pub reverb_delays_ms: [f32; REVERB_LINES],
    pub reverb_diffusers_ms: [f32; REVERB_DIFFUSERS],
    pub limiter_lookahead_ms: f32,
    pub limiter_release_ms: f32,
    pub gain_smooth_ms: f32,
    pub table_frames: usize,
    pub table_base_harmonics: usize,
    pub table_oversample: usize,
    pub table_min_size: usize,
    pub table_max_frames: usize,
    pub max_tables: usize,
    pub random_seed: u32,
}

impl Cfg {
    pub fn from_slice(v: &[f32]) -> Cfg {
        let g = |i: usize| -> f32 {
            match v.get(i) {
                Some(x) if x.is_finite() => *x,
                _ => 0.0,
            }
        };
        let u = |i: usize, min: usize| -> usize { (g(i).max(0.0) as usize).max(min) };
        let mut reverb_delays_ms = [0.0f32; REVERB_LINES];
        for (k, d) in reverb_delays_ms.iter_mut().enumerate() {
            *d = g(25 + k).max(1.0);
        }
        let mut reverb_diffusers_ms = [0.0f32; REVERB_DIFFUSERS];
        for (k, d) in reverb_diffusers_ms.iter_mut().enumerate() {
            *d = g(33 + k).max(0.1);
        }
        Cfg {
            max_polyphony: u(0, 1),
            max_unison: u(1, 1),
            control_block: u(2, 1),
            steal_fade_ms: g(3).max(0.01),
            voice_kill_db: g(4).min(-20.0),
            env_curve_epsilon: g(5).max(1e-9).min(0.5),
            velocity_curve: g(6).max(0.01),
            filter_env_octaves: g(7),
            filter_min_hz: g(8).max(1.0),
            filter_max_ratio: g(9).max(0.01).min(0.49),
            filter_max_resonance: g(10).max(0.0).min(0.999),
            drive_threshold_db: g(11),
            mod_pitch_semis: g(12),
            keytrack_center: g(13),
            keytrack_span: g(14).max(1.0),
            noise_tilt: g(15).max(1e-4).min(1.0),
            tuning_a4: g(16).max(1.0),
            chorus_base_ms: g(17).max(0.1),
            chorus_depth_ms: g(18).max(0.0),
            delay_max_sec: g(19).max(0.01),
            delay_smooth_ms: g(20).max(0.01),
            reverb_min_decay: g(21).max(0.01),
            reverb_max_decay: g(22).max(0.02),
            reverb_damp_max: g(23).max(0.0).min(0.999),
            reverb_diffusion: g(24).max(0.0).min(0.95),
            reverb_delays_ms,
            reverb_diffusers_ms,
            limiter_lookahead_ms: g(37).max(0.01),
            limiter_release_ms: g(38).max(0.1),
            gain_smooth_ms: g(39).max(0.01),
            table_frames: u(40, 1),
            table_base_harmonics: u(41, 1),
            table_oversample: u(42, 1),
            table_min_size: u(43, 4),
            table_max_frames: u(44, 1),
            max_tables: u(45, 1),
            random_seed: (g(46).max(1.0) as u32).max(1),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::params::json_string_array;

    #[test]
    fn config_keys_match_params_json() {
        let keys = json_string_array(include_str!("../params.json"), "config");
        assert_eq!(keys, CONFIG_KEYS.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    }
}
