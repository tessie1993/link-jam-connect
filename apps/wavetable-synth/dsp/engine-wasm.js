/* Thin JS wrapper around the Rust/WebAssembly engine (dsp-rs, plain C ABI). Used by the AudioWorklet
 * processor (audio), by the page (a second instance only to read wavetables for the 3D view) and by
 * the tests. All DSP happens in wasm; this file only moves numbers in and out of wasm memory.
 *
 * CONFIG_KEYS / FACTORY_TABLES / CONTROLLERS mirror dsp-rs/params.json (tests check they agree).
 */

export const CONFIG_KEYS = [
  'engine.maxPolyphony', 'engine.maxUnison', 'engine.controlBlock', 'engine.stealFadeMs', 'engine.voiceKillDb',
  'engine.envCurveEpsilon', 'engine.velocityCurve', 'engine.filterEnvOctaves', 'engine.filterMinHz', 'engine.filterMaxRatio',
  'engine.filterMaxResonance', 'engine.driveThresholdDb', 'engine.modPitchSemis', 'engine.keytrackCenterNote', 'engine.keytrackSpanSemis',
  'engine.noiseTiltCoef', 'engine.tuningA4', 'engine.chorusBaseMs', 'engine.chorusDepthMs', 'engine.delayMaxSec',
  'engine.delaySmoothMs', 'engine.reverbMinDecaySec', 'engine.reverbMaxDecaySec', 'engine.reverbDampMax', 'engine.reverbDiffusion',
  'engine.reverbDelaysMs[0]', 'engine.reverbDelaysMs[1]', 'engine.reverbDelaysMs[2]', 'engine.reverbDelaysMs[3]',
  'engine.reverbDelaysMs[4]', 'engine.reverbDelaysMs[5]', 'engine.reverbDelaysMs[6]', 'engine.reverbDelaysMs[7]',
  'engine.reverbDiffusersMs[0]', 'engine.reverbDiffusersMs[1]', 'engine.reverbDiffusersMs[2]', 'engine.reverbDiffusersMs[3]',
  'engine.limiterLookaheadMs', 'engine.limiterReleaseMs', 'engine.gainSmoothMs',
  'wavetable.frames', 'wavetable.baseHarmonics', 'wavetable.oversample', 'wavetable.minTableSize', 'wavetable.maxFrames',
  'wavetable.maxTables', 'engine.randomSeed'
];

export const FACTORY_TABLES = ['Basic Shapes', 'PWM', 'Vocal', 'Harmonic Sweep', 'Digital', 'Hard Sync', 'Organ'];
export const CONTROLLERS = { bend: 0, wheel: 1, aftertouch: 2, sustain: 3 };
export const SHAPE_CODES = { linear: 0, step: 1, exp: 2, s: 3 };
export const SCALE_CODES = { lin: 0, exp: 1, db: 2 };
export const MAX_DIVISIONS = 32;

/** Value of a config path like "engine.reverbDelaysMs[3]" in client.synth. */
export function configPath(synthCfg, path) {
  let v = synthCfg;
  for (const part of path.split('.')) {
    const m = /^(\w+)(?:\[(\d+)\])?$/.exec(part);
    if (!m || v === undefined || v === null) return undefined;
    v = v[m[1]];
    if (m[2] !== undefined) v = Array.isArray(v) ? v[Number(m[2])] : undefined;
  }
  return v;
}

/** Flat config for synth_new, in CONFIG_KEYS order. Throws naming every missing key. */
export function configValues(synthCfg) {
  const missing = [];
  const out = new Float32Array(CONFIG_KEYS.length);
  CONFIG_KEYS.forEach((k, i) => {
    const v = configPath(synthCfg, k);
    if (typeof v !== 'number' || !Number.isFinite(v)) missing.push(k);
    else out[i] = v;
  });
  if (missing.length) throw new Error(`client.synth: missing/invalid ${missing.join(', ')}`);
  return out;
}

/** Imports for the wasm module: none are expected; anything unexpected gets a stub that throws. */
function stubImports(module) {
  const imports = {};
  for (const imp of WebAssembly.Module.imports(module)) {
    imports[imp.module] = imports[imp.module] || {};
    if (imp.kind === 'function') imports[imp.module][imp.name] = () => { throw new Error(`wasm import ${imp.module}.${imp.name} not provided`); };
  }
  return imports;
}

export class WasmSynth {
  /**
   * @param {{module?: WebAssembly.Module, exports?: object}} src compiled module, or exports (tests)
   * @param {number} sampleRate
   * @param {object} synthCfg client.synth
   * @param {Array} schema buildSchema() output (index = engine parameter id)
   * @param {number} maxFrames largest process() block
   */
  constructor(src, sampleRate, synthCfg, schema, maxFrames) {
    this.x = src.exports || new WebAssembly.Instance(src.module, stubImports(src.module)).exports;
    const x = this.x;
    for (const fn of ['wt_alloc', 'wt_dealloc', 'synth_new', 'synth_process', 'synth_set_param', 'synth_ramp_param', 'synth_note_on', 'synth_note_off', 'synth_set_link', 'synth_load_table']) {
      if (typeof x[fn] !== 'function') throw new Error(`engine wasm has no export ${fn}`);
    }
    if (x.synth_config_len() !== CONFIG_KEYS.length) throw new Error(`engine expects ${x.synth_config_len()} config values, JS has ${CONFIG_KEYS.length}`);
    const vals = configValues(synthCfg);
    const cp = x.wt_alloc(vals.length);
    this.mem().set(vals, cp >>> 2);
    this.ptr = x.synth_new(sampleRate, cp, vals.length);
    x.wt_dealloc(cp, vals.length);
    if (!this.ptr) throw new Error('synth_new failed');
    this.maxFrames = maxFrames;
    this.outL = x.wt_alloc(maxFrames);
    this.outR = x.wt_alloc(maxFrames);
    this.capacity = x.synth_param_capacity();
    (synthCfg.syncDivisions || []).slice(0, MAX_DIVISIONS).forEach((d, i) => x.synth_set_division(this.ptr, i, d.beats));
    this.setSchema(schema);
  }

  /** Float32 view of wasm memory (re-created when the memory grew). */
  mem() {
    const buf = this.x.memory.buffer;
    if (buf !== this._buf) {
      this._buf = buf;
      this._f32 = new Float32Array(buf);
    }
    return this._f32;
  }

  setSchema(schema) {
    const fixed = this.x.synth_fixed_param_count();
    const slots = (schema.length - fixed) / 3;
    if (!(slots >= 0) || slots > this.x.synth_max_mod_slots() || schema.length > this.capacity) {
      throw new Error(`schema (${schema.length} params) does not fit the engine (${fixed} fixed + ${this.x.synth_max_mod_slots()} matrix slots)`);
    }
    this.schema = schema;
    this.index = new Map(schema.map((p, i) => [p.id, i]));
    schema.forEach((p, i) => this.x.synth_param_info(this.ptr, i, p.min, p.max, SCALE_CODES[p.scale] || 0, p.steps || 0));
  }

  set(i, norm) { this.x.synth_set_param(this.ptr, i, norm); }
  get(i) { return this.x.synth_get_param(this.ptr, i); }
  ramp(i, target, frames, shape = 0) { this.x.synth_ramp_param(this.ptr, i, target, frames, shape); }
  noteOn(note, velocity, offset = 0) { this.x.synth_note_on(this.ptr, note, velocity, offset); }
  noteOff(note, offset = 0) { this.x.synth_note_off(this.ptr, note, offset); }
  controller(kind, value, offset = 0) { this.x.synth_controller(this.ptr, kind, value, offset); }
  allNotesOff(hard, offset = 0) { this.x.synth_all_notes_off(this.ptr, hard ? 1 : 0, offset); }
  setLink(beat, tempo, playing) { this.x.synth_set_link(this.ptr, beat, tempo > 0 ? tempo : 0, playing ? 1 : 0); }

  /** Render into two Float32Arrays of equal length (<= maxFrames). */
  process(L, R) {
    const n = Math.min(L.length, this.maxFrames);
    this.x.synth_process(this.ptr, this.outL, this.outR, n);
    const m = this.mem();
    L.set(m.subarray(this.outL >>> 2, (this.outL >>> 2) + n));
    R.set(m.subarray(this.outR >>> 2, (this.outR >>> 2) + n));
  }

  activeVoices() { return this.x.synth_active_voices(this.ptr); }
  voiceNote(i) { return this.x.synth_voice_note(this.ptr, i); }
  takePeak(ch) { return this.x.synth_take_peak(this.ptr, ch); }
  reduction() { return this.x.synth_limiter_reduction(this.ptr); }
  delayTime() { return this.x.synth_delay_time(this.ptr); }

  /** Effective normalized values (base + offset + matrix of the newest voice), one per schema param. */
  modView() {
    const p = this.x.synth_mod_view(this.ptr);
    return this.mem().slice(p >>> 2, (p >>> 2) + this.schema.length);
  }

  tableCount() { return this.x.synth_table_count(this.ptr); }

  /** Copy of a table's richest level: {frames, size, data}. */
  tableLevel0(slot) {
    const frames = this.x.synth_table_frames(this.ptr, slot);
    const size = this.x.synth_table_level_size(this.ptr, slot, 0);
    const p = this.x.synth_table_level_ptr(this.ptr, slot, 0);
    if (!frames || !size || !p) return null;
    return { frames, size, data: this.mem().slice(p >>> 2, (p >>> 2) + frames * size) };
  }

  /** Build a wavetable from mono samples (frames of frameSize). Returns the slot or a negative error. */
  loadTable(slot, samples, frameSize) {
    const frames = Math.floor(samples.length / frameSize);
    const n = frames * frameSize;
    if (frames < 1) return -2;
    const p = this.x.wt_alloc(n);
    this.mem().set(samples.subarray(0, n), p >>> 2);
    const r = this.x.synth_load_table(this.ptr, slot, p, frames, frameSize);
    this.x.wt_dealloc(p, n);
    return r;
  }
}
