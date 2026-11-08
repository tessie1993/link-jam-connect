/* AudioWorklet host of the Rust/WebAssembly synth engine. All DSP runs in wasm; this file only
 * forwards parameters and events and copies the rendered audio out of wasm memory.
 *
 * Load with audioWorklet.addModule('worklet/processor.js?modSlots=<client.synth.modSlots>'): the
 * AudioParam descriptors must exist when the module registers, before any node options, and the
 * number of matrix slots comes from the config, so the module reads it from its own URL.
 *
 * processorOptions: {config: client.synth, schema: buildSchema(), wasmModule: WebAssembly.Module
 *                    | wasmBytes: ArrayBuffer (fallback when a Module cannot be cloned)}
 *
 * AudioParams (normalized): "<id>" = base 0..1 and "<id>.mod" = bipolar offset -1..1 for every
 * modulatable parameter, so JAM_PARAM_SET / JAM_PARAM_CURVE are scheduled sample-accurately by Web
 * Audio. Per render quantum the effective value clamp(base + mod) goes to the engine: constant ->
 * synth_set_param; automated -> synth_ramp_param to the value at the end of the quantum.
 *
 * Port messages in: {type:'schema'|'link'|'panic'|'table'} apply on arrival; {type:'note'|'ctl'|
 * 'stepped'|'allNotesOff', time?} apply at AudioContext time `time` as a sample offset inside the
 * quantum. Out: {type:'ready'|'error'|'meter'|'tableLoaded'}.
 */
import { modulatableIds } from '../dsp/params.js';
import { WasmSynth, CONTROLLERS, SHAPE_CODES } from '../dsp/engine-wasm.js';

const query = new URL(import.meta.url).searchParams;
const MOD_SLOTS = Number(query.get('modSlots'));
if (!(MOD_SLOTS >= 0)) throw new Error('processor.js needs ?modSlots=<client.synth.modSlots> in its URL');
const MOD_IDS = modulatableIds({ modSlots: MOD_SLOTS });

const clamp01 = (x) => (x > 0 ? (x < 1 ? x : 1) : 0);

class JCWavetableSynthProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const d = [];
    for (const id of MOD_IDS) {
      d.push({ name: id, defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' });
      d.push({ name: `${id}.mod`, defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'a-rate' });
    }
    return d;
  }

  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.cfg = o.config;
    this.queue = [];
    this.link = null;
    this.blocks = 0;
    this.synth = null;
    try {
      const src = o.wasmExports ? { exports: o.wasmExports }
        : { module: o.wasmModule || new WebAssembly.Module(o.wasmBytes) };
      this.synth = new WasmSynth(src, sampleRate, this.cfg, o.schema, this.cfg.engine.renderQuantum);
      this.bind(o.schema);
      this.meterEvery = Math.max(1, Math.round(sampleRate / this.cfg.engine.meterHz / this.cfg.engine.renderQuantum));
      this.port.postMessage({ type: 'ready', tables: this.synth.tableCount(), sampleRate });
    } catch (err) {
      this.synth = null;
      this.port.postMessage({ type: 'error', message: String((err && err.message) || err) });
    }
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  bind(schema) {
    this.schema = schema;
    const idx = new Map(schema.map((p, i) => [p.id, i]));
    this.modIdx = MOD_IDS.map((id) => idx.get(id));
    this.idIndex = idx;
    this.last = new Float32Array(MOD_IDS.length).fill(NaN);
  }

  onMessage(m) {
    if (!m || !m.type || !this.synth) return;
    switch (m.type) {
      case 'schema':
        this.synth.setSchema(m.schema);
        this.bind(m.schema);
        break;
      case 'link': this.link = m; break;
      case 'panic': this.queue = []; this.synth.allNotesOff(true, 0); break;
      case 'table': {
        const slot = this.synth.loadTable(m.slot, m.samples, m.frameSize);
        this.port.postMessage({ type: 'tableLoaded', slot, requestId: m.requestId });
        break;
      }
      default: this.enqueue(m);
    }
  }

  enqueue(m) {
    const frame = typeof m.time === 'number' && Number.isFinite(m.time) ? Math.round(m.time * sampleRate) : -Infinity;
    const q = this.queue;
    let i = q.length;
    while (i > 0 && q[i - 1].frame > frame) i--;
    q.splice(i, 0, { frame, m });
  }

  deliver(m, offset) {
    const s = this.synth;
    switch (m.type) {
      case 'note':
        if (m.on) s.noteOn(m.note, m.velocity, offset);
        else s.noteOff(m.note, offset);
        break;
      case 'ctl':
        if (CONTROLLERS[m.kind] !== undefined) s.controller(CONTROLLERS[m.kind], m.value, offset);
        break;
      case 'stepped': {
        const i = this.idIndex.get(m.id);
        if (i === undefined) break;
        if (offset > 0) s.ramp(i, m.norm, offset, SHAPE_CODES.step);
        else s.set(i, m.norm);
        break;
      }
      case 'allNotesOff': s.allNotesOff(false, offset); break;
      default:
    }
  }

  process(_inputs, outputs, parameters) {
    const out = outputs[0];
    const L = out && out[0];
    if (!L) return true;
    const R = out[1] || L;
    if (!this.synth) { L.fill(0); if (R !== L) R.fill(0); return true; }
    const s = this.synth;
    const n = L.length;
    const f0 = currentFrame;

    // Link: beat at the first frame of this quantum, from the main thread's (time, beat) mapping
    const lk = this.link;
    if (lk && lk.tempo > 0) s.setLink(lk.beat + ((f0 / sampleRate - lk.time) * lk.tempo) / 60, lk.tempo, lk.playing);
    else s.setLink(0, 0, false);

    // AudioParams -> engine
    for (let k = 0; k < MOD_IDS.length; k++) {
      const i = this.modIdx[k];
      if (i === undefined) continue;
      const base = parameters[MOD_IDS[k]];
      const mod = parameters[`${MOD_IDS[k]}.mod`];
      if (!base) continue;
      if (base.length === 1 && (!mod || mod.length === 1)) {
        const v = clamp01(base[0] + (mod ? mod[0] : 0));
        if (v !== this.last[k]) { s.set(i, v); this.last[k] = v; }
      } else {
        const v0 = clamp01(base[0] + (mod ? mod[0] : 0));
        const e = n - 1;
        const v1 = clamp01((base.length > 1 ? base[e] : base[0]) + (mod ? (mod.length > 1 ? mod[e] : mod[0]) : 0));
        if (v0 !== this.last[k]) s.set(i, v0);
        s.ramp(i, v1, n, SHAPE_CODES.linear);
        this.last[k] = v1;
      }
    }

    // timed events due in this quantum, as sample offsets
    const q = this.queue;
    while (q.length && q[0].frame < f0 + n) {
      const { frame, m } = q.shift();
      this.deliver(m, Math.max(0, frame - f0));
    }

    if (R === L) {
      const tmp = this._tmp || (this._tmp = new Float32Array(n));
      s.process(L, tmp);
    } else {
      s.process(L, R);
    }

    if (++this.blocks >= this.meterEvery) {
      this.blocks = 0;
      const view = s.modView();
      const values = new Float32Array(MOD_IDS.length);
      for (let k = 0; k < MOD_IDS.length; k++) values[k] = this.modIdx[k] === undefined ? 0 : view[this.modIdx[k]];
      this.port.postMessage({ type: 'meter', ids: MOD_IDS, values, voices: s.activeVoices(), peakL: s.takePeak(0), peakR: s.takePeak(1), reduction: s.reduction() });
    }
    return true;
  }
}

registerProcessor('jc-wavetable-synth', JCWavetableSynthProcessor);
