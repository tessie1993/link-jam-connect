/* Parameter schema of the wavetable synth (shared by the UI, the AudioWorklet and the tests).
 *
 * The *layout* (which parameters exist, their scale, unit, group, whether they can be modulated)
 * is the synth's architecture and lives here. Every *number* (min, max, default) and every
 * default choice comes from jamconnect.config.json -> client.synth.params, so nothing tunable is
 * built in. buildSchema() merges both and validates the config.
 *
 * Param = {id, name, group, unit, scale: "lin"|"exp"|"db", kind: "num"|"int"|"items", steps?,
 *          valueItems?, min, max, default, modulatable}   (the PARAMS-PROTOCOL manifest entry)
 * Values on the wire are normalized 0..1 ("norm").
 */

export const ON_OFF = ['Off', 'On'];
export const SUB_OCTAVES = ['-1', '-2'];
export const SUB_SHAPES = ['Sine', 'Triangle', 'Square'];
export const FILTER_TYPES = ['LP12', 'LP24', 'BP', 'HP', 'Notch'];
export const LFO_SHAPES = ['Sine', 'Triangle', 'Saw Up', 'Saw Down', 'Square', 'S&H', 'Smooth Random'];
export const LFO_RETRIG = ['Free', 'Note', 'Beat'];
export const VOICE_MODES = ['Poly', 'Mono', 'Legato'];
export const GLIDE_MODES = ['Off', 'Always', 'Legato'];
export const ENV_COUNT = 3;
export const LFO_COUNT = 2;
export const OSC_COUNT = 2;

/** Modulation matrix sources (index = value of modN.src). */
export const MOD_SOURCES = ['None', 'Env 1', 'Env 2', 'Env 3', 'LFO 1', 'LFO 2', 'Velocity', 'Mod Wheel',
  'Key Track', 'Aftertouch', 'Random', 'Pitch Bend'];

/** Modulation matrix destinations: label and the parameter it offsets (normalized), or a special target. */
export const MOD_DESTS = [
  { label: 'None' },
  { label: 'Osc1 Pos', param: 'osc1.pos' },
  { label: 'Osc2 Pos', param: 'osc2.pos' },
  { label: 'Pitch', special: 'pitch' },
  { label: 'Osc1 Pitch', special: 'pitch1' },
  { label: 'Osc2 Pitch', special: 'pitch2' },
  { label: 'Osc1 Level', param: 'osc1.level' },
  { label: 'Osc2 Level', param: 'osc2.level' },
  { label: 'Osc1 Detune', param: 'osc1.detune' },
  { label: 'Osc2 Detune', param: 'osc2.detune' },
  { label: 'Sub Level', param: 'sub.level' },
  { label: 'Noise Level', param: 'noise.level' },
  { label: 'Cutoff', param: 'filter.cutoff' },
  { label: 'Resonance', param: 'filter.reso' },
  { label: 'Drive', param: 'filter.drive' },
  { label: 'Amp', param: 'amp.level' },
  { label: 'Pan', special: 'pan' },
  { label: 'LFO1 Rate', param: 'lfo1.rate' },
  { label: 'LFO2 Rate', param: 'lfo2.rate' }
];

const P = (id, name, group, scale, unit, kind, modulatable, items) => ({ id, name, group, scale, unit, kind, modulatable, items });

/**
 * Parameter layout. `items` names a value list: a constant array, or a key resolved by buildSchema()
 * ("tables" = loaded wavetables, "divisions" = client.synth.syncDivisions labels).
 * @param {{modSlots:number}} layout structural counts from config
 */
export function paramLayout(layout) {
  const modSlots = Number(layout && layout.modSlots);
  if (!(modSlots >= 0)) throw new Error('client.synth.modSlots missing');
  const L = [];
  for (let o = 1; o <= OSC_COUNT; o++) {
    const g = `Osc ${o}`;
    const k = `osc${o}`;
    L.push(
      P(`${k}.on`, 'On', g, 'lin', '', 'items', false, ON_OFF),
      P(`${k}.table`, 'Wavetable', g, 'lin', '', 'items', false, 'tables'),
      P(`${k}.pos`, 'Position', g, 'lin', '', 'num', true),
      P(`${k}.oct`, 'Octave', g, 'lin', 'oct', 'int', false),
      P(`${k}.semi`, 'Semi', g, 'lin', 'st', 'int', false),
      P(`${k}.fine`, 'Fine', g, 'lin', 'ct', 'num', true),
      P(`${k}.level`, 'Level', g, 'lin', '', 'num', true),
      P(`${k}.pan`, 'Pan', g, 'lin', '', 'num', true),
      P(`${k}.unison`, 'Unison', g, 'lin', 'v', 'int', false),
      P(`${k}.detune`, 'Detune', g, 'lin', 'ct', 'num', true),
      P(`${k}.spread`, 'Spread', g, 'lin', '', 'num', true),
      P(`${k}.phase`, 'Phase', g, 'lin', '', 'num', false),
      P(`${k}.rand`, 'Rand Phase', g, 'lin', '', 'num', false)
    );
  }
  L.push(
    P('sub.level', 'Sub', 'Sub / Noise', 'lin', '', 'num', true),
    P('sub.oct', 'Sub Oct', 'Sub / Noise', 'lin', '', 'items', false, SUB_OCTAVES),
    P('sub.shape', 'Sub Shape', 'Sub / Noise', 'lin', '', 'items', false, SUB_SHAPES),
    P('noise.level', 'Noise', 'Sub / Noise', 'lin', '', 'num', true),
    P('noise.color', 'Color', 'Sub / Noise', 'lin', '', 'num', true),

    P('filter.on', 'On', 'Filter', 'lin', '', 'items', false, ON_OFF),
    P('filter.type', 'Type', 'Filter', 'lin', '', 'items', false, FILTER_TYPES),
    P('filter.cutoff', 'Cutoff', 'Filter', 'exp', 'Hz', 'num', true),
    P('filter.reso', 'Reso', 'Filter', 'lin', '', 'num', true),
    P('filter.drive', 'Drive', 'Filter', 'lin', 'dB', 'num', true),
    P('filter.key', 'Key Trk', 'Filter', 'lin', '', 'num', true),
    P('filter.env', 'Env 2 Amt', 'Filter', 'lin', '', 'num', true),

    P('amp.level', 'Level', 'Amp', 'db', 'dB', 'num', true),
    P('amp.velSens', 'Vel Sens', 'Amp', 'lin', '', 'num', true)
  );
  for (let e = 1; e <= ENV_COUNT; e++) {
    const g = `Env ${e}`;
    L.push(
      P(`env${e}.a`, 'Attack', g, 'exp', 's', 'num', true),
      P(`env${e}.d`, 'Decay', g, 'exp', 's', 'num', true),
      P(`env${e}.s`, 'Sustain', g, 'lin', '', 'num', true),
      P(`env${e}.r`, 'Release', g, 'exp', 's', 'num', true)
    );
  }
  for (let l = 1; l <= LFO_COUNT; l++) {
    const g = `LFO ${l}`;
    L.push(
      P(`lfo${l}.shape`, 'Shape', g, 'lin', '', 'items', false, LFO_SHAPES),
      P(`lfo${l}.rate`, 'Rate', g, 'exp', 'Hz', 'num', true),
      P(`lfo${l}.sync`, 'Sync', g, 'lin', '', 'items', false, ON_OFF),
      P(`lfo${l}.div`, 'Division', g, 'lin', '', 'items', false, 'divisions'),
      P(`lfo${l}.retrig`, 'Retrig', g, 'lin', '', 'items', false, LFO_RETRIG),
      P(`lfo${l}.phase`, 'Phase', g, 'lin', '', 'num', false)
    );
  }
  L.push(
    P('voice.mode', 'Mode', 'Voice', 'lin', '', 'items', false, VOICE_MODES),
    P('voice.poly', 'Voices', 'Voice', 'lin', '', 'int', false),
    P('voice.glideMode', 'Glide', 'Voice', 'lin', '', 'items', false, GLIDE_MODES),
    P('voice.glide', 'Glide Time', 'Voice', 'exp', 's', 'num', true),
    P('voice.bend', 'Bend Range', 'Voice', 'lin', 'st', 'int', false),

    P('chorus.on', 'Chorus', 'FX', 'lin', '', 'items', false, ON_OFF),
    P('chorus.rate', 'Ch Rate', 'FX', 'exp', 'Hz', 'num', true),
    P('chorus.depth', 'Ch Depth', 'FX', 'lin', '', 'num', true),
    P('chorus.mix', 'Ch Mix', 'FX', 'lin', '', 'num', true),
    P('delay.on', 'Delay', 'FX', 'lin', '', 'items', false, ON_OFF),
    P('delay.sync', 'Dly Sync', 'FX', 'lin', '', 'items', false, ON_OFF),
    P('delay.div', 'Dly Div', 'FX', 'lin', '', 'items', false, 'divisions'),
    P('delay.time', 'Dly Time', 'FX', 'exp', 's', 'num', true),
    P('delay.feedback', 'Feedback', 'FX', 'lin', '', 'num', true),
    P('delay.mix', 'Dly Mix', 'FX', 'lin', '', 'num', true),
    P('delay.pingpong', 'Ping-Pong', 'FX', 'lin', '', 'items', false, ON_OFF),
    P('delay.tone', 'Dly Tone', 'FX', 'exp', 'Hz', 'num', true),
    P('reverb.on', 'Reverb', 'FX', 'lin', '', 'items', false, ON_OFF),
    P('reverb.size', 'Size', 'FX', 'lin', '', 'num', true),
    P('reverb.damp', 'Damp', 'FX', 'lin', '', 'num', true),
    P('reverb.mix', 'Rev Mix', 'FX', 'lin', '', 'num', true),

    P('master.gain', 'Master', 'Master', 'db', 'dB', 'num', true),
    P('master.limit', 'Limiter', 'Master', 'lin', '', 'items', false, ON_OFF),
    P('master.ceiling', 'Ceiling', 'Master', 'lin', 'dB', 'num', true)
  );
  // Matrix slots last: the Rust engine addresses them as FIXED_COUNT + 3 * slot + field.
  for (let m = 1; m <= modSlots; m++) {
    const g = 'Mod Matrix';
    L.push(
      P(`mod${m}.src`, `Slot ${m} Source`, g, 'lin', '', 'items', false, MOD_SOURCES),
      P(`mod${m}.dst`, `Slot ${m} Dest`, g, 'lin', '', 'items', false, MOD_DESTS.map((d) => d.label)),
      P(`mod${m}.amt`, `Slot ${m} Amount`, g, 'lin', '', 'num', true)
    );
  }
  return L;
}

/** Ids of the parameters that get an AudioParam pair (base + ".mod" offset) in the worklet. */
export function modulatableIds(layout) {
  return paramLayout(layout).filter((p) => p.modulatable).map((p) => p.id);
}

/**
 * Full manifest: layout + ranges/defaults from config.
 * @param {object} synthCfg client.synth
 * @param {{tables: string[]}} lists dynamic value lists
 */
export function buildSchema(synthCfg, lists = {}) {
  const ranges = synthCfg.params || {};
  const divisions = (synthCfg.syncDivisions || []).map((d) => d.label);
  const resolve = (items) => (Array.isArray(items) ? items : items === 'tables' ? (lists.tables || []) : items === 'divisions' ? divisions : null);
  return paramLayout(synthCfg).map((p) => {
    const cfg = ranges[p.id];
    if (cfg === undefined) throw new Error(`client.synth.params["${p.id}"] missing in jamconnect.config.json`);
    const out = { id: p.id, name: p.name, group: p.group, unit: p.unit, scale: p.scale, kind: p.kind, modulatable: p.modulatable };
    if (p.kind === 'items') {
      const items = resolve(p.items);
      if (!items || !items.length) throw new Error(`no value items for ${p.id}`);
      let def = items.indexOf(String(cfg));
      if (def < 0) {
        if (p.items !== 'tables') throw new Error(`client.synth.params["${p.id}"]: "${cfg}" is not one of ${items.join(', ')}`);
        def = 0; // a configured table that is not loaded (yet)
      }
      Object.assign(out, { valueItems: items.slice(), steps: items.length, min: 0, max: items.length - 1, default: def });
    } else {
      if (!Array.isArray(cfg) || cfg.length !== 3 || !cfg.every(Number.isFinite)) throw new Error(`client.synth.params["${p.id}"] must be [min, max, default]`);
      const [min, max, def] = cfg;
      if (!(max > min) || def < min || def > max) throw new Error(`client.synth.params["${p.id}"]: need min < max and min <= default <= max`);
      if (p.scale === 'exp' && !(min > 0)) throw new Error(`client.synth.params["${p.id}"]: exp scale needs min > 0`);
      Object.assign(out, { min, max, default: def });
      if (p.kind === 'int') out.steps = Math.round(max - min) + 1;
    }
    return out;
  });
}

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const dbToAmp = (db) => Math.pow(10, db / 20);
export const ampToDb = (a) => 20 * Math.log10(a);

/** Snap a norm to the parameter's steps (no-op for continuous params). */
export function quantizeNorm(p, norm) {
  const n = clamp01(Number(norm) || 0);
  if (!(p.steps > 1)) return p.steps === 1 ? 0 : n;
  return Math.round(n * (p.steps - 1)) / (p.steps - 1);
}

/**
 * norm 0..1 -> value.  lin: linear;  exp: min*(max/min)^norm;  db: linear in amplitude between
 * dbToAmp(min) and dbToAmp(max) (so 0.5 on -60..+6 dB is ~0 dB);  steps: snapped to the grid.
 */
export function denormalize(p, norm) {
  const n = quantizeNorm(p, norm);
  if (p.steps > 1) return p.min + Math.round(n * (p.steps - 1)) * (p.max - p.min) / (p.steps - 1);
  switch (p.scale) {
    case 'exp': return p.min * Math.pow(p.max / p.min, n);
    case 'db': {
      const a0 = dbToAmp(p.min), a1 = dbToAmp(p.max);
      const a = a0 + n * (a1 - a0);
      return a <= 0 ? p.min : Math.max(p.min, Math.min(p.max, ampToDb(a)));
    }
    default: return p.min + n * (p.max - p.min);
  }
}

/** value -> norm 0..1 (inverse of denormalize, clamped). Item params also accept the label. */
export function normalize(p, value) {
  let v = value;
  if (p.valueItems && typeof v === 'string') {
    const i = p.valueItems.indexOf(v);
    v = i >= 0 ? i : p.default;
  }
  v = Number(v);
  if (!Number.isFinite(v)) v = p.default;
  v = Math.max(p.min, Math.min(p.max, v));
  let n;
  switch (p.steps > 1 ? 'lin' : p.scale) {
    case 'exp': n = Math.log(v / p.min) / Math.log(p.max / p.min); break;
    case 'db': {
      const a0 = dbToAmp(p.min), a1 = dbToAmp(p.max);
      n = (dbToAmp(v) - a0) / (a1 - a0);
      break;
    }
    default: n = (v - p.min) / (p.max - p.min);
  }
  return quantizeNorm(p, n);
}

/** Human-readable value for the UI. */
export function formatValue(p, value) {
  if (p.valueItems) return p.valueItems[Math.round(value)] ?? String(value);
  const v = Number(value);
  switch (p.unit) {
    case 'Hz': return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${v.toFixed(v < 1 ? 3 : v < 10 ? 2 : 0)} Hz`;
    case 's': return v >= 1 ? `${v.toFixed(2)} s` : `${(v * 1000).toFixed(v < 0.01 ? 1 : 0)} ms`;
    case 'dB': return `${v.toFixed(1)} dB`;
    case 'ct': return `${v.toFixed(0)} ct`;
    case 'st': return `${v > 0 ? '+' : ''}${v.toFixed(0)} st`;
    case 'oct': return `${v > 0 ? '+' : ''}${v.toFixed(0)} oct`;
    case 'v': return `${v.toFixed(0)}`;
    default: return p.min < 0 ? `${v > 0 ? '+' : ''}${(v * 100).toFixed(0)}%` : `${(v * 100).toFixed(0)}%`;
  }
}

/** Map id -> param for a schema array. */
export function indexSchema(schema) {
  const m = new Map();
  schema.forEach((p, i) => m.set(p.id, Object.assign(p, { index: i })));
  return m;
}
