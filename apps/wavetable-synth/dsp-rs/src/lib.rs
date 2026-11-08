//! JamConnect wavetable synth engine, compiled to wasm32-unknown-unknown with a plain C ABI
//! (no wasm-bindgen). The JS side (apps/wavetable-synth/worklet/processor.js) owns scheduling and
//! calls these exports from the AudioWorklet; see params.json for the parameter/config contract.
//!
//! Memory: buffers are allocated with `wt_alloc(len)` (f32 count) and freed with `wt_dealloc`.
//! Allocating calls (synth_new, synth_load_table, wt_alloc) can grow the wasm memory, so JS must
//! re-create its typed-array views after them. synth_process never allocates.

#![allow(clippy::missing_safety_doc)]

pub mod cfg;
pub mod fx;
pub mod params;
pub mod synth;
pub mod wavetable;

use synth::Synth;

/// Allocate `len` zeroed f32s; returns a pointer into wasm memory.
#[no_mangle]
pub extern "C" fn wt_alloc(len: usize) -> *mut f32 {
    let b: Box<[f32]> = vec![0.0f32; len].into_boxed_slice();
    Box::into_raw(b) as *mut f32
}

/// Free a buffer from `wt_alloc` (same `len`).
#[no_mangle]
pub unsafe extern "C" fn wt_dealloc(ptr: *mut f32, len: usize) {
    if ptr.is_null() {
        return;
    }
    let s = core::ptr::slice_from_raw_parts_mut(ptr, len);
    drop(Box::from_raw(s));
}

/// Create a synth. `cfg` points to `cfg_len` f32 values in params.json "config" order.
#[no_mangle]
pub unsafe extern "C" fn synth_new(sample_rate: f32, cfg: *const f32, cfg_len: usize) -> *mut Synth {
    let values: &[f32] = if cfg.is_null() { &[] } else { core::slice::from_raw_parts(cfg, cfg_len) };
    Box::into_raw(Box::new(Synth::new(sample_rate, values)))
}

#[no_mangle]
pub unsafe extern "C" fn synth_free(p: *mut Synth) {
    if !p.is_null() {
        drop(Box::from_raw(p));
    }
}

#[inline]
unsafe fn s<'a>(p: *mut Synth) -> Option<&'a mut Synth> {
    p.as_mut()
}

#[no_mangle]
pub extern "C" fn synth_param_capacity() -> u32 {
    params::PARAM_CAPACITY as u32
}

#[no_mangle]
pub extern "C" fn synth_fixed_param_count() -> u32 {
    params::FIXED_COUNT as u32
}

#[no_mangle]
pub extern "C" fn synth_max_mod_slots() -> u32 {
    params::MAX_MOD_SLOTS as u32
}

#[no_mangle]
pub extern "C" fn synth_config_len() -> u32 {
    cfg::CONFIG_KEYS.len() as u32
}

/// Range of a parameter: scale 0 = lin, 1 = exp, 2 = db; steps 0 = continuous.
#[no_mangle]
pub unsafe extern "C" fn synth_param_info(p: *mut Synth, id: u32, min: f32, max: f32, scale: u32, steps: u32) {
    if let Some(s) = s(p) {
        s.set_param_info(id as usize, min, max, scale, steps);
    }
}

/// Set a parameter (normalized 0..1, effective value incl. any modulation offset).
#[no_mangle]
pub unsafe extern "C" fn synth_set_param(p: *mut Synth, id: u32, norm: f32) {
    if let Some(s) = s(p) {
        s.params.set(id as usize, norm);
    }
}

/// Ramp a parameter to `target` (normalized) over `frames` samples. shape: 0 linear, 1 step, 2 exp, 3 s-curve.
#[no_mangle]
pub unsafe extern "C" fn synth_ramp_param(p: *mut Synth, id: u32, target: f32, frames: u32, shape: u32) {
    if let Some(s) = s(p) {
        s.params.ramp_to(id as usize, target, frames, shape);
    }
}

#[no_mangle]
pub unsafe extern "C" fn synth_get_param(p: *mut Synth, id: u32) -> f32 {
    match s(p) {
        Some(s) if (id as usize) < params::PARAM_CAPACITY => s.params.norm[id as usize],
        _ => 0.0,
    }
}

/// Beats of sync division `index` (client.synth.syncDivisions).
#[no_mangle]
pub unsafe extern "C" fn synth_set_division(p: *mut Synth, index: u32, beats: f32) {
    if let Some(s) = s(p) {
        s.set_division(index as usize, beats);
    }
}

/// Link state at the first frame of the next synth_process call. tempo <= 0: no Link tempo.
#[no_mangle]
pub unsafe extern "C" fn synth_set_link(p: *mut Synth, beat: f64, tempo: f32, playing: u32) {
    if let Some(s) = s(p) {
        s.set_link(tempo, beat, playing != 0);
    }
}

/// Note on at `offset` samples from the start of the next synth_process call. velocity 0..1.
#[no_mangle]
pub unsafe extern "C" fn synth_note_on(p: *mut Synth, note: i32, velocity: f32, offset: u32) {
    if let Some(s) = s(p) {
        s.note_on(note, velocity, offset);
    }
}

#[no_mangle]
pub unsafe extern "C" fn synth_note_off(p: *mut Synth, note: i32, offset: u32) {
    if let Some(s) = s(p) {
        s.note_off(note, offset);
    }
}

/// Controller: 0 pitch bend (-1..1), 1 mod wheel, 2 aftertouch, 3 sustain (0..1).
#[no_mangle]
pub unsafe extern "C" fn synth_controller(p: *mut Synth, kind: u32, value: f32, offset: u32) {
    if let Some(s) = s(p) {
        s.controller(kind, value, offset);
    }
}

/// Release every note (hard = 1: silence immediately and clear the queue).
#[no_mangle]
pub unsafe extern "C" fn synth_all_notes_off(p: *mut Synth, hard: u32, offset: u32) {
    if let Some(s) = s(p) {
        s.all_notes_off(hard != 0, offset);
    }
}

/// Render `frames` samples into two wasm buffers (from wt_alloc).
#[no_mangle]
pub unsafe extern "C" fn synth_process(p: *mut Synth, out_l: *mut f32, out_r: *mut f32, frames: u32) {
    let s = match s(p) {
        Some(s) => s,
        None => return,
    };
    if out_l.is_null() || out_r.is_null() || frames == 0 {
        return;
    }
    let l = core::slice::from_raw_parts_mut(out_l, frames as usize);
    let r = core::slice::from_raw_parts_mut(out_r, frames as usize);
    s.process(l, r);
}

/// Build a wavetable from `frame_count * frame_size` mono samples. slot == table count appends.
/// Returns the slot or a negative error. Allocates (call outside process).
#[no_mangle]
pub unsafe extern "C" fn synth_load_table(p: *mut Synth, slot: u32, samples: *const f32, frame_count: u32, frame_size: u32) -> i32 {
    let s = match s(p) {
        Some(s) => s,
        None => return -3,
    };
    if samples.is_null() {
        return -3;
    }
    let data = core::slice::from_raw_parts(samples, frame_count as usize * frame_size as usize);
    s.load_table(slot as usize, data, frame_size as usize)
}

#[no_mangle]
pub unsafe extern "C" fn synth_table_count(p: *mut Synth) -> u32 {
    s(p).map_or(0, |s| s.tables.len() as u32)
}

#[no_mangle]
pub unsafe extern "C" fn synth_table_frames(p: *mut Synth, slot: u32) -> u32 {
    s(p).and_then(|s| s.tables.get(slot as usize)).map_or(0, |t| t.frames as u32)
}

#[no_mangle]
pub unsafe extern "C" fn synth_table_levels(p: *mut Synth, slot: u32) -> u32 {
    s(p).and_then(|s| s.tables.get(slot as usize)).map_or(0, |t| t.levels.len() as u32)
}

#[no_mangle]
pub unsafe extern "C" fn synth_table_level_size(p: *mut Synth, slot: u32, level: u32) -> u32 {
    s(p).and_then(|s| s.tables.get(slot as usize)).and_then(|t| t.levels.get(level as usize)).map_or(0, |l| l.size as u32)
}

#[no_mangle]
pub unsafe extern "C" fn synth_table_level_harmonics(p: *mut Synth, slot: u32, level: u32) -> u32 {
    s(p).and_then(|s| s.tables.get(slot as usize)).and_then(|t| t.levels.get(level as usize)).map_or(0, |l| l.harmonics as u32)
}

/// Pointer to level data (frames * size f32, frame-major). Valid until the next allocating call.
#[no_mangle]
pub unsafe extern "C" fn synth_table_level_ptr(p: *mut Synth, slot: u32, level: u32) -> *const f32 {
    s(p).and_then(|s| s.tables.get(slot as usize))
        .and_then(|t| t.levels.get(level as usize))
        .map_or(core::ptr::null(), |l| l.data.as_ptr())
}

#[no_mangle]
pub unsafe extern "C" fn synth_active_voices(p: *mut Synth) -> u32 {
    s(p).map_or(0, |s| s.active_voices())
}

/// Note of voice `i`, or -1 when idle.
#[no_mangle]
pub unsafe extern "C" fn synth_voice_note(p: *mut Synth, i: u32) -> i32 {
    match s(p).and_then(|s| s.voices.get(i as usize)) {
        Some(v) if v.active => v.note,
        _ => -1,
    }
}

/// Output peak of channel 0/1 since the last call (then reset).
#[no_mangle]
pub unsafe extern "C" fn synth_take_peak(p: *mut Synth, ch: u32) -> f32 {
    match s(p) {
        Some(s) if ch < 2 => {
            let v = s.peak[ch as usize];
            s.peak[ch as usize] = 0.0;
            v
        }
        _ => 0.0,
    }
}

#[no_mangle]
pub unsafe extern "C" fn synth_limiter_reduction(p: *mut Synth) -> f32 {
    s(p).map_or(1.0, |s| s.limiter_reduction())
}

/// Refresh and return the effective-value view (PARAM_CAPACITY f32: base + matrix of the newest voice).
#[no_mangle]
pub unsafe extern "C" fn synth_mod_view(p: *mut Synth) -> *const f32 {
    match s(p) {
        Some(s) => {
            s.update_mod_view();
            s.mod_view.as_ptr()
        }
        None => core::ptr::null(),
    }
}

#[no_mangle]
pub unsafe extern "C" fn synth_delay_time(p: *mut Synth) -> f32 {
    s(p).map_or(0.0, |s| s.delay_time())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffi_roundtrip() {
        unsafe {
            let n = synth_config_len() as usize;
            let cfg = wt_alloc(n);
            let c = core::slice::from_raw_parts_mut(cfg, n);
            for (i, k) in cfg::CONFIG_KEYS.iter().enumerate() {
                c[i] = match *k {
                    "engine.maxPolyphony" => 4.0,
                    "engine.controlBlock" => 16.0,
                    "wavetable.frames" => 4.0,
                    "wavetable.baseHarmonics" => 32.0,
                    "wavetable.oversample" => 4.0,
                    "wavetable.minTableSize" => 64.0,
                    _ => 1.0,
                };
            }
            let p = synth_new(48000.0, cfg, n);
            wt_dealloc(cfg, n);
            assert!(!p.is_null());
            assert_eq!(synth_table_count(p), 7);
            assert!(synth_table_level_size(p, 0, 0) >= 64);
            assert!(!synth_table_level_ptr(p, 0, 0).is_null());
            synth_set_param(p, params::FILTER_CUTOFF as u32, 0.5);
            assert!((synth_get_param(p, params::FILTER_CUTOFF as u32) - 0.5).abs() < 1e-6);
            let l = wt_alloc(128);
            let r = wt_alloc(128);
            synth_note_on(p, 60, 1.0, 0);
            synth_process(p, l, r, 128);
            let out = core::slice::from_raw_parts(l, 128);
            assert!(out.iter().all(|x| x.is_finite()));
            assert_eq!(synth_voice_note(p, 0), 60);
            assert_eq!(synth_voice_note(p, 3), -1);
            synth_process(core::ptr::null_mut(), l, r, 128); // no crash
            wt_dealloc(l, 128);
            wt_dealloc(r, 128);
            synth_free(p);
        }
    }
}
