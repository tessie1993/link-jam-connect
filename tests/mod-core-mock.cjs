// Test-only JavaScript stand-in for the Rust/WebAssembly modulation core (apps/mod-device/core-rs).
// Same exports and memory model (f64 buffers in a WebAssembly.Memory), so the JS shell can be tested
// locally without a Rust toolchain. It implements the subset the shell tests exercise (LFO, beat /
// gate / manual envelopes, touch pads without physics, motion shake, routes, transforms, curve
// rendering + decimation, self / remote modulation). The shipped app always uses the real core.
'use strict';
const path = require('node:path');
const S = require(path.join(__dirname, '..', 'apps', 'mod-device', 'schema.js'));

const CODES = Object.fromEntries(Object.entries(S.TYPES).map(([k, t]) => [t.code, { name: k, ...t }]));
const clamp = (v, lo, hi) => (Number.isNaN(v) ? lo : v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);
const frac = (x) => x - Math.floor(x);
const fin = Number.isFinite;
const MOD = [1, 1.5, 2 / 3];
const divBeats = (bars, m, q) => bars * (q > 0 ? q : 1) * (MOD[Math.round(m)] || 1);
function ease(c, u, k) {
  u = clamp01(u);
  if (c === 1) return k > 0 ? (Math.exp(k * u) - 1) / (Math.exp(k) - 1) : u;
  if (c === 2) return k > 0 ? 1 - (Math.exp(k * (1 - u)) - 1) / (Math.exp(k) - 1) : u;
  if (c === 3) return u * u * (3 - 2 * u);
  return u;
}
function shape(s, pos, pw) {
  const p = frac(pos);
  switch (s) {
    case 0: return Math.sin(2 * Math.PI * p);
    case 1: return p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4;
    case 2: return 2 * p - 1;
    case 3: return 1 - 2 * p;
    case 4: return p < pw ? 1 : -1;
    default: return 0;
  }
}
function envLevel(st, sus, on, off, start, t, k) {
  if (!fin(on) || !st.length || !fin(t)) return 0;
  if (t < on) return start;
  const run = (from, to, level, dt) => {
    for (let i = from; i <= to && i < st.length; i++) {
      const d = Math.max(0, st[i].dur);
      if (dt < d) return level + (st[i].level - level) * ease(st[i].curve, dt / d, k);
      dt -= d; level = st[i].level;
    }
    return level;
  };
  if (sus < 0 || sus >= st.length) return run(0, st.length - 1, start, t - on);
  if (!fin(off) || t < off) return run(0, sus, start, t - on);
  return run(sus + 1, st.length - 1, run(0, sus, start, off - on), t - off);
}
function decimate(pts, tol) {
  const n = pts.length, keep = new Uint8Array(n);
  if (!n) return keep;
  keep[0] = keep[n - 1] = 1;
  const stack = n > 2 ? [[0, n - 1]] : [];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxE = -1, idx = 0;
    for (let i = a + 1; i < b; i++) {
      const span = pts[b].beat - pts[a].beat;
      const v = span > 0 ? pts[a].value + (pts[b].value - pts[a].value) * (pts[i].beat - pts[a].beat) / span : pts[a].value;
      const e = Math.abs(pts[i].value - v);
      if (e > maxE) { maxE = e; idx = i; }
    }
    if (idx > 0 && maxE > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return keep;
}
function r2n(d, v) {
  if (d.max === d.min) return 0;
  if (d.exp && d.min > 0 && v > 0) return clamp01(Math.log(v / d.min) / Math.log(d.max / d.min));
  return clamp01((v - d.min) / (d.max - d.min));
}
function n2r(d, n) { n = clamp01(n); return d.exp && d.min > 0 ? d.min * Math.pow(d.max / d.min, n) : d.min + n * (d.max - d.min); }
function applyEff(base, def, rAbs, rOff, sAbs, sOff) {
  const has = fin(rAbs) || fin(sAbs) || rOff !== 0 || sOff !== 0;
  if (!has || !def || def.max === def.min) return base;
  let n = fin(rAbs) ? rAbs : fin(sAbs) ? sAbs : r2n(def, base);
  return n2r(def, clamp01(n + rOff + sOff));
}
function transform(raw, bi, off, tf, st, dt) {
  let u = bi ? (clamp(raw, -1, 1) + 1) / 2 : clamp01(raw);
  if (tf.invert) u = 1 - u;
  if (tf.curve) u = ease(tf.curve, u, tf.curveAmount);
  if (tf.steps >= 2) { const n = Math.round(tf.steps) - 1; u = Math.round(u * n) / n; }
  const b = tf.polarity === 1 ? false : tf.polarity === 2 ? true : bi;
  let out = off ? clamp(tf.offset + tf.depth * (b ? 2 * u - 1 : u), -1, 1) : clamp01(tf.offset + tf.depth * u);
  if (st) {
    if (tf.slew > 0 && fin(st.v)) { const m = (off ? 2 : 1) * Math.max(0, dt) / tf.slew; st.v += clamp(out - st.v, -m, m); out = st.v; } else st.v = out;
  }
  return out;
}

function createMockCore() {
  const memory = new WebAssembly.Memory({ initial: 64 });
  let heap = 4096;
  const alloc = (count) => {
    const p = heap;
    heap = (heap + Math.max(1, count) * 8 + 7) & ~7;
    if (heap > memory.buffer.byteLength) memory.grow(Math.ceil((heap - memory.buffer.byteLength) / 65536));
    return p;
  };
  const f64 = (p, n) => new Float64Array(memory.buffer, p, n);
  let cfg = [], sources = [], routes = [], outPtr = 0, outCap = 0, hold = false, frozen = false, last = { has: false, beat: NaN, now: 0, quantum: 4, tempo: 0 }, lastBeat = NaN;
  let global = { v: 1, def: null, rAbs: NaN, rOff: 0, sAbs: NaN, sOff: 0, eff: 1 };
  const C = (k) => cfg[S.CONFIG_KEYS.indexOf(k)];
  const newSource = (code) => ({ code, t: CODES[code], params: new Array(24).fill(0), eff: new Array(24).fill(0), defs: [], rAbs: new Array(24).fill(NaN), rOff: new Array(24).fill(0), sAbs: new Array(24).fill(NaN), sOff: new Array(24).fill(0),
    refs: [[-1, 0], [-1, 0], [-1, 0]], data: [], values: new Array(12).fill(0), prev: new Array(12).fill(0), ptrs: [], latched: false, trigBeat: NaN, trigMs: NaN, on: NaN, off: NaN, start: 0, vel: 1, lastInput: -Infinity, shakeUntil: -Infinity, lastShake: -Infinity, zero: [0, 0, 0] });
  const newRoute = () => ({ used: false, enabled: false, src: [-1, 0], off: false, curve: false, tf: { depth: 1, offset: 0, curve: 0, curveAmount: 1, slew: 0, steps: 0, invert: false, polarity: 0 },
    defs: [null, null], rAbs: [NaN, NaN], rOff: [0, 0], sAbs: [NaN, NaN], sOff: [0, 0], eff: [1, 0], st: { v: NaN }, value: 0, input: 0, active: false, predictable: false, buf: [], anchor: false, cursor: NaN, rst: { v: NaN }, rlast: NaN, selfs: [] });
  const bip = (s, o) => !!s && (s.t.name === 'sh' ? true : s.t.bipolar.includes(s.t.outputs[o]));
  const E = (s, i) => s.eff[i];
  const name = (s) => s && s.t.name;
  const lfoVal = (s, beat, ms, q) => {
    const rt = Math.round(E(s, 10));
    let pos;
    if (E(s, 1) < 0.5) {
      if (!fin(beat)) return 0;
      let anchor = 0;
      if (rt === 1) anchor = Math.floor(beat / q) * q; else if (rt === 2 && fin(s.trigBeat)) anchor = s.trigBeat;
      const per = divBeats(E(s, 2), E(s, 3), q);
      if (!(per > 0)) return 0;
      pos = (beat - anchor) / per + E(s, 5);
    } else pos = (ms - (rt === 2 && fin(s.trigMs) ? s.trigMs : 0)) / 1000 * E(s, 4) + E(s, 5);
    return shape(Math.round(E(s, 0)), pos, E(s, 6)) * E(s, 7);
  };
  const envStages = (s) => {
    const A = { dur: E(s, 2), level: 1, curve: Math.round(E(s, 7)) }, D = { dur: E(s, 4), level: clamp01(E(s, 5)), curve: Math.round(E(s, 8)) }, R = { dur: E(s, 6), level: 0, curve: Math.round(E(s, 8)) };
    return Math.round(E(s, 0)) === 1 ? [[A, { dur: E(s, 3), level: 1, curve: 0 }, D, R], 2] : [[A, D, R], 1];
  };
  const envT = (s, ctx) => (E(s, 1) >= 0.5 ? ctx.now : ctx.beat);
  const envLvl = (s, t) => { const [st, sus] = envStages(s); return envLevel(st, sus, s.on, s.off, s.start, t, C('curve.expCurve')); };
  const envBeat = (s, beat) => {
    const every = E(s, 10);
    if (!(every > 0) || !fin(beat)) return 0;
    const [st, sus] = envStages(s), k = C('curve.expCurve'), on = Math.floor(beat / every) * every, gl = E(s, 11);
    return envLevel(st, sus, on, on + gl, envLevel(st, sus, on - every, on - every + gl, 0, on, k), beat, k);
  };
  const gateOn = (s, t) => { if (!fin(t)) return; s.start = fin(s.on) ? envLvl(s, t) : 0; s.on = t; s.off = NaN; s.vel = 1; };
  const predictable = (s, o) => ['lfo'].includes(name(s)) || (name(s) === 'env' && Math.round(E(s, 9)) === 3 && E(s, 1) < 0.5);
  const valueAt = (s, o, beat, ms, q) => (name(s) === 'lfo' ? lfoVal(s, beat, ms, q) : name(s) === 'env' && predictable(s, o) ? envBeat(s, beat) * E(s, 17) : s.values[o]);
  const active = (s, ctx) => (name(s) === 'pad' ? s.ptrs.length > 0 || s.latched : ['motion', 'mic'].includes(name(s)) ? ctx.now - s.lastInput < C('sensors.staleMs') : !!s);
  const refIn = (r) => {
    const s = sources[r[0]];
    if (!s || r[1] < 0 || r[1] >= s.t.outputs.length) return { valid: false };
    const b = bip(s, r[1]), uni = (v) => (b ? (clamp(v, -1, 1) + 1) / 2 : clamp01(v));
    const cur = uni(s.values[r[1]]), prev = uni(s.prev[r[1]]);
    return { valid: true, value: s.values[r[1]], uni: cur, rise: prev < 0.5 && cur >= 0.5, fall: prev >= 0.5 && cur < 0.5 };
  };
  function evaluate(s, ctx) {
    const q = ctx.quantum;
    switch (name(s)) {
      case 'lfo': {
        const r = refIn(s.refs[0]);
        if (r.valid && r.rise) { s.trigBeat = ctx.beat; s.trigMs = ctx.now; }
        s.values[0] = lfoVal(s, ctx.beat, ctx.now, q);
        break;
      }
      case 'env': {
        const mode = Math.round(E(s, 9)), beats = E(s, 1) < 0.5;
        if (beats && !ctx.has) { s.values[0] = 0; return; }
        if (mode === 3 && beats) { s.values[0] = clamp01(envBeat(s, ctx.beat) * E(s, 17)); return; }
        const t = envT(s, ctx), r = refIn(s.refs[0]);
        if ((mode === 0 || mode === 1) && r.valid) {
          if (r.rise) { gateOn(s, t); if (mode === 1) s.off = t + E(s, 11); }
          if (mode === 0 && r.fall && fin(s.on) && !fin(s.off)) s.off = t;
        }
        s.values[0] = clamp01(envLvl(s, t) * s.vel * E(s, 17));
        break;
      }
      case 'pad': {
        const p = s.ptrs[0];
        if (p) { s.values[0] = p.x; s.values[1] = p.y; s.values[2] = fin(p.pressure) ? p.pressure : C('gestures.forceDefault'); }
        s.values[11] = s.ptrs.length ? 1 : 0;
        s.values[5] = clamp01(s.ptrs.length / C('gestures.maxFingers'));
        if (!p) s.values[2] = 0;
        break;
      }
      case 'motion': s.values[10] = ctx.now < s.shakeUntil ? 1 : 0; break;
      default:
    }
  }
  const routeRender = (r, beat, ms, st, dt) => {
    const s = sources[r.src[0]];
    if (!s) return r.value;
    return transform(valueAt(s, r.src[1], beat, ms, last.quantum), bip(s, r.src[1]), r.off, { ...r.tf, depth: r.eff[0] * global.eff, offset: r.eff[1] }, st, dt);
  };
  const push = (r, beat, v) => {
    if (!fin(beat) || !fin(v)) return 0;
    const l = r.buf[r.buf.length - 1];
    if (l && !(beat > l.beat)) return 0;
    if (r.buf.length >= C('curve.bufferPoints')) return 0;
    r.buf.push({ beat, value: v });
    return 1;
  };
  const src = (slot) => sources[slot];
  const ex = {
    memory,
    core_version: () => 1,
    core_alloc: (n) => alloc(n),
    core_dealloc: () => {},
    core_init: (seed, ms, mr, bp, oc) => {
      cfg = new Array(S.CONFIG_KEYS.length).fill(0);
      sources = new Array(ms).fill(null);
      routes = Array.from({ length: mr }, newRoute);
      outCap = Math.max(2, oc);
      outPtr = alloc(outCap);
      return 1;
    },
    core_config_count: () => S.CONFIG_KEYS.length,
    core_set_config: (k, v) => { if (k < cfg.length && fin(v)) cfg[k] = v; },
    core_type_count: () => 17,
    core_type_param_count: (c) => (CODES[c] ? CODES[c].params.length : 0),
    core_type_output_count: (c) => (CODES[c] ? CODES[c].outputs.length : 0),
    core_type_ref_count: (c) => (CODES[c] ? CODES[c].refs.length : 0),
    core_type_output_bipolar: (c, o) => (CODES[c] && CODES[c].bipolar.includes(CODES[c].outputs[o]) ? 1 : 0),
    core_source_create: (slot, code) => { if (slot >= sources.length || !CODES[code]) return 0; sources[slot] = newSource(code); return 1; },
    core_source_remove: (slot) => { sources[slot] = null; },
    core_source_init: (slot) => { const s = src(slot); if (s) { s.eff = s.params.slice(); if (name(s) === 'pad') { s.values[0] = s.params[2]; s.values[1] = s.params[3]; } s.prev = s.values.slice(); } },
    core_source_set_param: (slot, i, v) => { const s = src(slot); if (s && fin(v)) { s.params[i] = v; s.eff[i] = v; } },
    core_source_param_def: (slot, i, min, max, exp, steps) => { const s = src(slot); if (s) s.defs[i] = { min, max, exp: !!exp, steps }; },
    core_source_set_ref: (slot, k, sl, o) => { const s = src(slot); if (s) s.refs[k] = [sl, o]; },
    core_source_set_data: (slot, ptr, n) => { const s = src(slot); if (s) s.data = n ? Array.from(f64(ptr, n)) : []; },
    core_source_value: (slot, o) => (src(slot) ? src(slot).values[o] : NaN),
    core_source_effective: (slot, i) => (src(slot) ? src(slot).eff[i] : NaN),
    core_source_bipolar: (slot, o) => (bip(src(slot), o) ? 1 : 0),
    core_source_active: (slot) => (src(slot) && active(src(slot), last) ? 1 : 0),
    core_source_info: () => -1,
    core_source_remote: (slot, i, abs, off) => { const s = src(slot); if (s) { s.rAbs[i] = abs; s.rOff[i] = fin(off) ? off : 0; } },
    core_pointer: (slot, phase, id, x, y, pressure, radius, t) => {
      const s = src(slot);
      if (!s || name(s) !== 'pad') return;
      const i = s.ptrs.findIndex((p) => p.id === id);
      if (phase === 0 && i < 0 && s.ptrs.length < C('gestures.maxFingers')) { s.ptrs.push({ id, x: clamp01(x), y: clamp01(y), pressure }); s.latched = false; }
      else if (phase === 1 && i >= 0) Object.assign(s.ptrs[i], { x: clamp01(x), y: clamp01(y), pressure });
      else if (phase === 2 && i >= 0) { const p = s.ptrs.splice(i, 1)[0]; if (!s.ptrs.length) { s.values[0] = p.x; s.values[1] = p.y; if (hold) s.latched = true; } }
    },
    core_motion_orientation: (slot, a, b, g, t) => { const s = src(slot); if (s) { const R = E(s, 0); [a, b, g].forEach((v, k) => { if (fin(v)) s.values[k] = clamp((v - s.zero[k]) / R, -1, 1); }); s.lastInput = t; } },
    core_motion_accel: (slot, ax, ay, az, gx, gy, gz, t) => {
      const s = src(slot);
      if (!s || !fin(ax)) return;
      const mag = Math.hypot(ax, ay, az);
      if (mag >= C('sensors.shakeThreshold') && t - s.lastShake >= C('sensors.shakeRefractoryMs')) { s.lastShake = t; s.shakeUntil = t + C('sensors.shakeGateMs'); }
      s.lastInput = t;
    },
    core_motion_rotation: (slot, a, b, g, t) => { const s = src(slot); if (s) s.lastInput = t; },
    core_motion_calibrate: () => {},
    core_motion_invert: () => {},
    core_trigger: (slot, on) => {
      const s = src(slot);
      if (!s) return;
      if (name(s) === 'lfo' && on) { s.trigBeat = last.beat; s.trigMs = last.now; }
      if (name(s) === 'env') { const t = envT(s, last); if (on) { gateOn(s, t); const m = Math.round(E(s, 9)); if (m !== 5 && m !== 0) s.off = t + E(s, 11); } else if (fin(s.on) && !fin(s.off)) s.off = t; }
      if (name(s) === 'motion' && on) { s.shakeUntil = last.now + C('sensors.shakeGateMs'); s.lastInput = last.now; }
    },
    core_midi: () => {},
    core_audio_block: () => {},
    core_set_hold: (on) => { hold = !!on; if (!hold) for (const s of sources) if (s && s.latched) s.latched = false; },
    core_set_frozen: (on) => { frozen = !!on; },
    core_global: (d, min, max) => { global.v = d; global.def = { min, max, exp: false }; },
    core_global_remote: (abs, off) => { global.rAbs = abs; global.rOff = fin(off) ? off : 0; },
    core_global_effective: () => global.eff,
    core_route_create: (slot) => { if (!routes[slot]) return 0; routes[slot] = newRoute(); routes[slot].used = true; return 1; },
    core_route_remove: (slot) => { if (routes[slot]) routes[slot] = newRoute(); },
    core_route_set: (slot, s, o, off, en, curve) => { const r = routes[slot]; if (!r) return; if (r.off !== !!off || r.src[0] !== s || r.src[1] !== o) { r.st = { v: NaN }; r.buf = []; r.anchor = false; r.cursor = NaN; } Object.assign(r, { src: [s, o], off: !!off, enabled: !!en, curve: !!curve }); },
    core_route_tf: (slot, depth, offset, curve, curveAmount, slew, steps, invert, polarity) => { const r = routes[slot]; if (r) r.tf = { depth, offset, curve, curveAmount, slew: Math.max(0, slew), steps, invert: !!invert, polarity }; },
    core_route_param_def: (slot, i, min, max) => { const r = routes[slot]; if (r) r.defs[i] = { min, max, exp: false }; },
    core_route_remote: (slot, i, abs, off) => { const r = routes[slot]; if (r) { r.rAbs[i] = abs; r.rOff[i] = fin(off) ? off : 0; } },
    core_route_effective: (slot, i) => (routes[slot] ? routes[slot].eff[i] : NaN),
    core_route_self_clear: (slot) => { if (routes[slot]) routes[slot].selfs = []; },
    core_route_self_add: (slot, kind, ts, idx) => { const r = routes[slot]; if (!r || r.selfs.length >= 8) return 0; r.selfs.push({ kind, ts, idx }); return 1; },
    core_route_value: (slot) => (routes[slot] ? routes[slot].value : NaN),
    core_route_input: (slot) => (routes[slot] ? routes[slot].input : NaN),
    core_route_active: (slot) => (routes[slot] && routes[slot].used && routes[slot].active ? 1 : 0),
    core_route_predictable: (slot) => (routes[slot] && routes[slot].predictable ? 1 : 0),
    core_route_peek: (slot, beat, ms) => { const r = routes[slot]; if (!r) return NaN; if (!r.predictable || !last.has || r.tf.slew > 0 || !fin(beat)) return r.value; return routeRender(r, beat, ms, null, 0); },
    core_route_reset: (slot) => { const r = routes[slot]; if (r) { r.buf = []; r.anchor = false; r.cursor = NaN; r.rst = { v: NaN }; r.rlast = NaN; } },
    core_route_push: (slot, beat, v) => (routes[slot] ? push(routes[slot], beat, v) : 0),
    core_route_flush: (slot) => {
      const r = routes[slot];
      if (!r) return 0;
      const first = r.anchor ? 1 : 0;
      if (r.buf.length <= first) return 0;
      let keep;
      if (r.tf.steps >= 2) { keep = new Uint8Array(r.buf.length); let lv = NaN; r.buf.forEach((p, i) => { if (!fin(lv) || Math.abs(p.value - lv) > C('curve.tolerance') / 2 || i === r.buf.length - 1) { keep[i] = 1; lv = p.value; } }); }
      else keep = decimate(r.buf, C('curve.tolerance'));
      const out = f64(outPtr, outCap);
      let k = 0;
      for (let i = first; i < r.buf.length; i++) if (keep[i] && k < outCap / 2) { out[2 * k] = r.buf[i].beat; out[2 * k + 1] = r.buf[i].value; k++; }
      r.buf = [r.buf[r.buf.length - 1]];
      r.anchor = true;
      return k;
    },
    core_out_ptr: () => outPtr,
    core_curve_value_at: (ptr, n, beat) => {
      if (!n) return NaN;
      const p = f64(ptr, n * 3);
      if (beat <= p[0]) return p[1];
      for (let i = 1; i < n; i++) if (beat < p[3 * i]) { const u = (beat - p[3 * i - 3]) / Math.max(1e-12, p[3 * i] - p[3 * i - 3]); return Math.round(p[3 * i + 2]) === 1 ? p[3 * i - 2] : p[3 * i - 2] + (p[3 * i + 1] - p[3 * i - 2]) * u; }
      return p[3 * n - 2];
    },
    core_tick: (beat, tempo, quantum, now, dt, lead) => {
      const has = fin(beat) && tempo > 0;
      let prev = lastBeat;
      if (has && fin(prev) && beat < prev) { prev = NaN; for (const r of routes) { r.buf = []; r.anchor = false; r.cursor = NaN; } }
      const ctx = { has, beat: has ? beat : NaN, prevBeat: has ? prev : NaN, tempo: has ? tempo : 0, quantum: quantum > 0 ? quantum : 1, now, dt: Math.max(0, dt || 0) };
      last = ctx;
      for (const s of sources) if (s) { s.sAbs.fill(NaN); s.sOff.fill(0); }
      for (const r of routes) { r.sAbs = [NaN, NaN]; r.sOff = [0, 0]; }
      global.sAbs = NaN; global.sOff = 0;
      for (const r of routes) {
        if (!r.used || !r.active) continue;
        for (const t of r.selfs) {
          const tgt = t.kind === 0 ? sources[t.ts] : t.kind === 1 ? routes[t.ts] : global;
          if (!tgt) continue;
          if (t.kind === 2) { if (r.off) global.sOff += r.value; else global.sAbs = r.value; continue; }
          if (r.off) tgt.sOff[t.idx] += r.value; else tgt.sAbs[t.idx] = r.value;
        }
      }
      for (const s of sources) if (s) for (let i = 0; i < s.t.params.length; i++) s.eff[i] = applyEff(s.params[i], s.defs[i], s.rAbs[i], s.rOff[i], s.sAbs[i], s.sOff[i]);
      for (const r of routes) if (r.used) { r.eff[0] = applyEff(r.tf.depth, r.defs[0], r.rAbs[0], r.rOff[0], r.sAbs[0], r.sOff[0]); r.eff[1] = applyEff(r.tf.offset, r.defs[1], r.rAbs[1], r.rOff[1], r.sAbs[1], r.sOff[1]); }
      global.eff = applyEff(global.v, global.def, global.rAbs, global.rOff, global.sAbs, global.sOff);
      const order = sources.map((s, i) => [s, i]).filter(([s]) => s).sort((a, b) => (['lfo', 'env', 'ball', 'well'].includes(name(a[0])) ? 1 : 0) - (['lfo', 'env', 'ball', 'well'].includes(name(b[0])) ? 1 : 0));
      for (const [s] of order) evaluate(s, ctx);
      let n = 0;
      for (const r of routes) {
        if (!r.used) continue;
        const s = sources[r.src[0]];
        const valid = !!s && r.src[1] >= 0 && r.src[1] < s.t.outputs.length;
        if (valid) { r.input = s.values[r.src[1]]; r.value = transform(r.input, bip(s, r.src[1]), r.off, { ...r.tf, depth: r.eff[0] * global.eff, offset: r.eff[1] }, r.st, ctx.dt); }
        r.active = r.enabled && !frozen && valid && active(s, ctx);
        r.predictable = valid && predictable(s, r.src[1]);
        if (r.active) n++;
        if (!r.active || !r.curve || !has) continue;
        const bpm = tempo / 60000, from = beat + Math.max(0, lead) * bpm;
        if (!r.predictable) { push(r, from, r.value); continue; }
        const to = from + C('curve.lookaheadMs') * bpm, step = C('curve.renderStepMs') * bpm;
        if (!fin(r.cursor) || r.cursor < from - step) r.cursor = from;
        while (r.cursor <= to) {
          const dtr = fin(r.rlast) ? (r.cursor - r.rlast) / bpm : 0;
          push(r, r.cursor, routeRender(r, r.cursor, now + (r.cursor - beat) / bpm, r.rst, dtr));
          r.rlast = r.cursor;
          r.cursor += step;
        }
      }
      for (const s of sources) if (s) s.prev = s.values.slice();
      lastBeat = has ? beat : NaN;
      return n;
    }
  };
  return ex;
}

module.exports = { createMockCore };
