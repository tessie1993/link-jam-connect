//! JamConnect Mod Device core: all modulation math, compiled to WebAssembly with a plain C ABI
//! (no wasm-bindgen). JavaScript is only the UI / IO shell: it feeds inputs (touch, sensors, MIDI,
//! audio blocks, the Link state, the measured latency, config) and reads values and per-route
//! curve batches (Link beats, decimated) from a shared f64 buffer.
//!
//! Conventions: slots are u32 indexes chosen by JS, NaN means "none" for optional f64 values,
//! buffers are f64-aligned and allocated with core_alloc / core_dealloc (counts in f64 elements).

pub mod dsp;
pub mod engine;

use engine::*;
use std::ptr::addr_of_mut;

const ABI_VERSION: u32 = 1;

static mut CORE: Option<Core> = None;

fn with<R>(default: R, f: impl FnOnce(&mut Core) -> R) -> R {
    // Safety: wasm32-unknown-unknown is single-threaded and JS calls are not re-entrant.
    unsafe {
        match (*addr_of_mut!(CORE)).as_mut() {
            Some(c) => f(c),
            None => default,
        }
    }
}

fn slice_f64<'a>(ptr: *const f64, n: u32) -> &'a [f64] {
    if ptr.is_null() || n == 0 {
        return &[];
    }
    unsafe { std::slice::from_raw_parts(ptr, n as usize) }
}

#[no_mangle]
pub extern "C" fn core_version() -> u32 {
    ABI_VERSION
}

/// Allocate `count` f64 elements (8-byte aligned). Not used in the tick path.
#[no_mangle]
pub extern "C" fn core_alloc(count: u32) -> *mut f64 {
    let mut v: Vec<f64> = Vec::with_capacity(count.max(1) as usize);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[no_mangle]
pub extern "C" fn core_dealloc(ptr: *mut f64, count: u32) {
    if !ptr.is_null() {
        unsafe { drop(Vec::from_raw_parts(ptr, 0, count.max(1) as usize)) };
    }
}

/// Create the engine. Every buffer is allocated here; the tick never allocates.
#[no_mangle]
pub extern "C" fn core_init(seed: u32, max_sources: u32, max_routes: u32, buffer_points: u32, out_capacity: u32) -> u32 {
    let c = Core::new(seed, max_sources as usize, max_routes as usize, buffer_points as usize, out_capacity as usize);
    unsafe { *addr_of_mut!(CORE) = Some(c) };
    1
}

#[no_mangle]
pub extern "C" fn core_config_count() -> u32 {
    CFG_COUNT as u32
}
#[no_mangle]
pub extern "C" fn core_set_config(key: u32, value: f64) {
    with((), |c| {
        if (key as usize) < CFG_COUNT && value.is_finite() {
            c.cfg[key as usize] = value;
        }
    })
}

#[no_mangle]
pub extern "C" fn core_type_count() -> u32 {
    TYPE_COUNT
}
#[no_mangle]
pub extern "C" fn core_type_param_count(ty: u32) -> u32 {
    type_param_count(ty) as u32
}
#[no_mangle]
pub extern "C" fn core_type_output_count(ty: u32) -> u32 {
    type_output_count(ty) as u32
}
#[no_mangle]
pub extern "C" fn core_type_ref_count(ty: u32) -> u32 {
    type_ref_count(ty) as u32
}
#[no_mangle]
pub extern "C" fn core_type_output_bipolar(ty: u32, out: u32) -> u32 {
    type_output_bipolar(ty, out as usize) as u32
}

// ---------------------------------------------------------------- sources
#[no_mangle]
pub extern "C" fn core_source_create(slot: u32, ty: u32) -> u32 {
    with(0, |c| c.source_create(slot as usize, ty) as u32)
}
#[no_mangle]
pub extern "C" fn core_source_remove(slot: u32) {
    with((), |c| c.source_remove(slot as usize))
}
#[no_mangle]
pub extern "C" fn core_source_init(slot: u32) {
    with((), |c| c.source_init(slot as usize))
}
#[no_mangle]
pub extern "C" fn core_source_set_param(slot: u32, idx: u32, value: f64) {
    with((), |c| c.set_param(slot as usize, idx as usize, value))
}
#[no_mangle]
pub extern "C" fn core_source_param_def(slot: u32, idx: u32, min: f64, max: f64, exp: u32, steps: f64) {
    with((), |c| {
        if let Some(s) = c.sources.get_mut(slot as usize) {
            if (idx as usize) < MAX_PARAMS {
                s.defs[idx as usize] = dsp::ParamDef { min, max, exp: exp != 0, steps };
            }
        }
    })
}
#[no_mangle]
pub extern "C" fn core_source_set_ref(slot: u32, k: u32, src: i32, out: i32) {
    with((), |c| c.set_ref(slot as usize, k as usize, src, out))
}
#[no_mangle]
pub extern "C" fn core_source_set_data(slot: u32, ptr: *const f64, n: u32) {
    let d = slice_f64(ptr, n);
    with((), |c| c.set_data(slot as usize, d))
}
#[no_mangle]
pub extern "C" fn core_source_value(slot: u32, out: u32) -> f64 {
    with(f64::NAN, |c| match c.sources.get(slot as usize) {
        Some(s) if (out as usize) < MAX_OUTS => s.values[out as usize],
        _ => f64::NAN,
    })
}
#[no_mangle]
pub extern "C" fn core_source_effective(slot: u32, idx: u32) -> f64 {
    with(f64::NAN, |c| c.effective(0, slot as usize, idx as usize))
}
#[no_mangle]
pub extern "C" fn core_source_bipolar(slot: u32, out: u32) -> u32 {
    with(0, |c| c.polarity_bi(slot as usize, out as usize) as u32)
}
#[no_mangle]
pub extern "C" fn core_source_active(slot: u32) -> u32 {
    with(0, |c| {
        let ctx = c.last;
        match c.sources.get(slot as usize) {
            Some(s) => s.active(&ctx, &c.cfg) as u32,
            None => 0,
        }
    })
}
#[no_mangle]
pub extern "C" fn core_source_info(slot: u32, what: u32) -> f64 {
    with(-1.0, |c| {
        let ctx = c.last;
        match c.sources.get(slot as usize) {
            Some(s) => s.info(what, &ctx),
            None => -1.0,
        }
    })
}
/// Remote modulation of a source parameter (PARAMS-PROTOCOL curves aimed at this device):
/// abs = absolute normalized value (NaN = none), off = bipolar offset.
#[no_mangle]
pub extern "C" fn core_source_remote(slot: u32, idx: u32, abs: f64, off: f64) {
    with((), |c| {
        if let Some(s) = c.sources.get_mut(slot as usize) {
            if (idx as usize) < MAX_PARAMS {
                s.remote_abs[idx as usize] = abs;
                s.remote_off[idx as usize] = if off.is_finite() { off } else { 0.0 };
            }
        }
    })
}

// ---------------------------------------------------------------- inputs
/// Touch / pointer: phase 0 down, 1 move, 2 up. x, y 0..1 (y up), pressure NaN = unknown, radius px, t ms.
#[no_mangle]
pub extern "C" fn core_pointer(slot: u32, phase: u32, id: i32, x: f64, y: f64, pressure: f64, radius: f64, t: f64) {
    with((), |c| {
        let hold = c.hold;
        let cfg = c.cfg;
        if let Some(s) = c.sources.get_mut(slot as usize) {
            s.pointer(phase, id, x, y, pressure, radius, t, hold, &cfg);
        }
    })
}
#[no_mangle]
pub extern "C" fn core_motion_orientation(slot: u32, alpha: f64, beta: f64, gamma: f64, t: f64) {
    with((), |c| {
        let cfg = c.cfg;
        if let Some(s) = c.sources.get_mut(slot as usize) {
            s.motion_orientation(alpha, beta, gamma, t, &cfg);
        }
    })
}
/// Linear acceleration (ax..az, NaN if unavailable) and acceleration including gravity (gx..gz).
#[no_mangle]
pub extern "C" fn core_motion_accel(slot: u32, ax: f64, ay: f64, az: f64, gx: f64, gy: f64, gz: f64, t: f64) {
    with((), |c| {
        let cfg = c.cfg;
        if let Some(s) = c.sources.get_mut(slot as usize) {
            s.motion_accel([ax, ay, az], [gx, gy, gz], t, &cfg);
        }
    })
}
#[no_mangle]
pub extern "C" fn core_motion_rotation(slot: u32, ra: f64, rb: f64, rg: f64, t: f64) {
    with((), |c| {
        let cfg = c.cfg;
        if let Some(s) = c.sources.get_mut(slot as usize) {
            s.motion_rotation([ra, rb, rg], t, &cfg);
        }
    })
}
#[no_mangle]
pub extern "C" fn core_motion_calibrate(slot: u32) {
    with((), |c| {
        if let Some(s) = c.sources.get_mut(slot as usize) {
            s.motion.calibrate();
        }
    })
}
#[no_mangle]
pub extern "C" fn core_motion_invert(slot: u32, ch: u32, on: u32) {
    with((), |c| {
        if let Some(s) = c.sources.get_mut(slot as usize) {
            if (ch as usize) < 10 {
                s.motion.invert[ch as usize] = on != 0;
            }
        }
    })
}
/// Manual trigger / gate (envelope, LFO retrigger, S&H sample, ball drop, simulated shake).
#[no_mangle]
pub extern "C" fn core_trigger(slot: u32, on: u32) {
    with((), |c| c.trigger(slot as usize, on != 0))
}
/// MIDI: kind 0 note on, 1 note off, 2 CC.
#[no_mangle]
pub extern "C" fn core_midi(kind: u32, num: i32, value: i32, channel: i32) {
    with((), |c| c.midi(kind, num, value, channel))
}
/// A block of microphone samples (f32) for the envelope follower.
#[no_mangle]
pub extern "C" fn core_audio_block(slot: u32, ptr: *const f32, n: u32, t: f64) {
    if ptr.is_null() || n == 0 {
        return;
    }
    let block = unsafe { std::slice::from_raw_parts(ptr, n as usize) };
    with((), |c| {
        if let Some(s) = c.sources.get_mut(slot as usize) {
            s.audio_block(block, t);
        }
    })
}
#[no_mangle]
pub extern "C" fn core_set_hold(on: u32) {
    with((), |c| c.set_hold(on != 0))
}
#[no_mangle]
pub extern "C" fn core_set_frozen(on: u32) {
    with((), |c| c.frozen = on != 0)
}

// ---------------------------------------------------------------- global depth
#[no_mangle]
pub extern "C" fn core_global(depth: f64, min: f64, max: f64) {
    with((), |c| {
        c.global = depth;
        c.gdef = dsp::ParamDef { min, max, exp: false, steps: 0.0 };
    })
}
#[no_mangle]
pub extern "C" fn core_global_remote(abs: f64, off: f64) {
    with((), |c| {
        c.g_remote_abs = abs;
        c.g_remote_off = if off.is_finite() { off } else { 0.0 };
    })
}
#[no_mangle]
pub extern "C" fn core_global_effective() -> f64 {
    with(f64::NAN, |c| c.g_eff)
}

// ---------------------------------------------------------------- routes
#[no_mangle]
pub extern "C" fn core_route_create(slot: u32) -> u32 {
    with(0, |c| match c.routes.get_mut(slot as usize) {
        Some(r) => {
            r.clear();
            r.used = true;
            1
        }
        None => 0,
    })
}
#[no_mangle]
pub extern "C" fn core_route_remove(slot: u32) {
    with((), |c| {
        if let Some(r) = c.routes.get_mut(slot as usize) {
            r.clear();
        }
    })
}
/// Route source (slot / output), mode (0 absolute, 1 offset), enabled, curve rendering on (JamConnect targets).
#[no_mangle]
pub extern "C" fn core_route_set(slot: u32, src: i32, out: i32, offset_mode: u32, enabled: u32, curve_on: u32) {
    with((), |c| {
        if let Some(r) = c.routes.get_mut(slot as usize) {
            let mode = offset_mode != 0;
            if r.offset_mode != mode || r.src.slot != src || r.src.out != out {
                r.state = f64::NAN;
                r.reset_curve();
            }
            r.src = Ref { slot: src, out };
            r.offset_mode = mode;
            r.enabled = enabled != 0;
            r.curve_on = curve_on != 0;
        }
    })
}
/// Transform: curve 0 lin, 1 exp, 2 log, 3 s; polarity 0 auto, 1 uni, 2 bi.
#[no_mangle]
pub extern "C" fn core_route_tf(slot: u32, depth: f64, offset: f64, curve: u32, curve_amount: f64, slew_ms: f64, steps: f64, invert: u32, polarity: u32) {
    with((), |c| {
        if let Some(r) = c.routes.get_mut(slot as usize) {
            r.tf = dsp::Tf { depth, offset, curve, curve_amount, slew_ms: slew_ms.max(0.0), steps, invert: invert != 0, polarity };
        }
    })
}
/// Range of a route's own parameter (0 depth, 1 offset) for normalized modulation.
#[no_mangle]
pub extern "C" fn core_route_param_def(slot: u32, idx: u32, min: f64, max: f64) {
    with((), |c| {
        if let Some(r) = c.routes.get_mut(slot as usize) {
            if idx < 2 {
                r.defs[idx as usize] = dsp::ParamDef { min, max, exp: false, steps: 0.0 };
            }
        }
    })
}
#[no_mangle]
pub extern "C" fn core_route_remote(slot: u32, idx: u32, abs: f64, off: f64) {
    with((), |c| {
        if let Some(r) = c.routes.get_mut(slot as usize) {
            if idx < 2 {
                r.remote_abs[idx as usize] = abs;
                r.remote_off[idx as usize] = if off.is_finite() { off } else { 0.0 };
            }
        }
    })
}
#[no_mangle]
pub extern "C" fn core_route_effective(slot: u32, idx: u32) -> f64 {
    with(f64::NAN, |c| c.effective(1, slot as usize, idx as usize))
}
#[no_mangle]
pub extern "C" fn core_route_self_clear(slot: u32) {
    with((), |c| {
        if let Some(r) = c.routes.get_mut(slot as usize) {
            r.nself = 0;
        }
    })
}
/// Route to one of this device's own parameters: kind 0 source param, 1 route param, 2 global depth.
#[no_mangle]
pub extern "C" fn core_route_self_add(slot: u32, kind: u32, target_slot: u32, idx: u32) -> u32 {
    with(0, |c| match c.routes.get_mut(slot as usize) {
        Some(r) if r.nself < MAX_SELF => {
            r.selfs[r.nself] = SelfT { kind, slot: target_slot, idx };
            r.nself += 1;
            1
        }
        _ => 0,
    })
}
#[no_mangle]
pub extern "C" fn core_route_value(slot: u32) -> f64 {
    with(f64::NAN, |c| c.routes.get(slot as usize).map(|r| r.value).unwrap_or(f64::NAN))
}
#[no_mangle]
pub extern "C" fn core_route_input(slot: u32) -> f64 {
    with(f64::NAN, |c| c.routes.get(slot as usize).map(|r| r.input).unwrap_or(f64::NAN))
}
#[no_mangle]
pub extern "C" fn core_route_active(slot: u32) -> u32 {
    with(0, |c| c.routes.get(slot as usize).map(|r| (r.used && r.active) as u32).unwrap_or(0))
}
#[no_mangle]
pub extern "C" fn core_route_predictable(slot: u32) -> u32 {
    with(0, |c| c.routes.get(slot as usize).map(|r| r.predictable as u32).unwrap_or(0))
}
/// Route value at a Link beat / local ms (ahead of time for predictable sources; else the current value).
#[no_mangle]
pub extern "C" fn core_route_peek(slot: u32, beat: f64, ms: f64) -> f64 {
    with(f64::NAN, |c| c.route_peek(slot as usize, beat, ms))
}
#[no_mangle]
pub extern "C" fn core_route_reset(slot: u32) {
    with((), |c| {
        if let Some(r) = c.routes.get_mut(slot as usize) {
            r.reset_curve();
        }
    })
}
#[no_mangle]
pub extern "C" fn core_route_push(slot: u32, beat: f64, value: f64) -> u32 {
    with(0, |c| c.routes.get_mut(slot as usize).map(|r| r.push(beat, value) as u32).unwrap_or(0))
}
/// Decimated pending breakpoints of a route -> core_out_ptr() as (beat, value) pairs. Returns the count.
#[no_mangle]
pub extern "C" fn core_route_flush(slot: u32) -> u32 {
    with(0, |c| c.route_flush(slot as usize) as u32)
}
#[no_mangle]
pub extern "C" fn core_out_ptr() -> *const f64 {
    with(std::ptr::null(), |c| c.out.as_ptr())
}

/// One engine step. beat = Link beat now (NaN: no timeline), tempo, quantum, now / dt in ms,
/// lead = ms ahead realtime points are stamped (measured one-way latency + send interval + margin).
#[no_mangle]
pub extern "C" fn core_tick(beat: f64, tempo: f64, quantum: f64, now: f64, dt: f64, lead: f64) -> u32 {
    with(0, |c| c.tick(beat, tempo, quantum, now, dt, lead))
}

/// Value at `beat` of received breakpoints given as (beat, norm, shape) triples (shape 0 linear,
/// 1 step, 2 exp, 3 s). NaN if empty.
#[no_mangle]
pub extern "C" fn core_curve_value_at(ptr: *const f64, n_points: u32, beat: f64) -> f64 {
    let pts = slice_f64(ptr, n_points.saturating_mul(3));
    let k = with(0.0, |c| c.cfg[C_EXP]);
    dsp::curve_value_at(pts, beat, k)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abi_roundtrip() {
        core_init(7, 8, 4, 256, 512);
        assert_eq!(core_config_count() as usize, CFG_COUNT);
        assert_eq!(core_type_param_count(engine::T_LFO), 12);
        assert_eq!(core_source_create(0, engine::T_LFO), 1);
        let p = [0.0, 1.0, 1.0, 0.0, 1.0, 0.0, 0.5, 1.0, 0.0, 0.0, 0.0, 1.0];
        for (i, v) in p.iter().enumerate() {
            core_source_set_param(0, i as u32, *v);
        }
        core_source_init(0);
        assert_eq!(core_route_create(0), 1);
        core_route_set(0, 0, 0, 0, 1, 0);
        core_route_tf(0, 1.0, 0.0, 0, 1.0, 0.0, 0.0, 0, 0);
        core_tick(f64::NAN, 0.0, 4.0, 250.0, 0.0, 0.0);
        assert!((core_source_value(0, 0) - 1.0).abs() < 1e-9);
        assert!((core_route_value(0) - 1.0).abs() < 1e-9);
        assert_eq!(core_route_active(0), 1);
        let buf = core_alloc(6);
        unsafe {
            let s = std::slice::from_raw_parts_mut(buf, 6);
            s.copy_from_slice(&[0.0, 0.0, 0.0, 2.0, 1.0, 0.0]);
        }
        assert!((core_curve_value_at(buf, 2, 1.0) - 0.5).abs() < 1e-12);
        core_dealloc(buf, 6);
        assert!(!core_out_ptr().is_null());
    }
}
