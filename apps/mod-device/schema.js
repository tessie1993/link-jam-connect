/* JamConnect Mod Device schema: metadata shared by the JS shell and mirrored in the Rust core ABI
 * (apps/mod-device/core-rs/src/engine.rs). It describes source types (parameter / output / reference
 * order = core indexes), the config keys the core needs, parameter units for PARAMS-PROTOCOL manifests
 * (normalized <-> real), and the factory scenes. No modulation math lives here.
 * Ranges and defaults come from client.modulator.ranges in jamconnect.config.json. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.JamModSchema = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /** client.modulator paths, in core config-key order (engine.rs C_* constants). */
  const CONFIG_KEYS = [
    'physics.stepMs', 'physics.maxSubsteps', 'physics.restVelocity', 'physics.restDistance',
    'curve.tolerance', 'curve.renderStepMs', 'curve.lookaheadMs', 'curve.expCurve',
    'sensors.staleMs', 'sensors.oneEuroDCutoff', 'sensors.shakeThreshold', 'sensors.shakeRefractoryMs', 'sensors.shakeGateMs', 'sensors.gravityLowpassHz',
    'gestures.maxFingers', 'gestures.swipeMinVelocity', 'gestures.swipeMinDistance', 'gestures.swipeGateMs', 'gestures.pinchRange', 'gestures.rotateRangeDeg',
    'gestures.velocityRange', 'gestures.radiusRangePx', 'gestures.forceDefault', 'gestures.throwIdleMs',
    'gestures.velocityFilter.minCutoff', 'gestures.velocityFilter.beta', 'gestures.velocityFilter.dCutoff',
    'seq.gateFraction',
    'lorenz.sigma', 'lorenz.rho', 'lorenz.beta', 'lorenz.dt', 'lorenz.stepMs', 'lorenz.initial.0', 'lorenz.initial.1', 'lorenz.initial.2',
    'lorenz.bounds.x', 'lorenz.bounds.y', 'lorenz.bounds.zMin', 'lorenz.bounds.zMax',
    'logistic.initial', 'logistic.maxIterationsPerTick', 'ball.dropHeight',
    'well.start.0', 'well.start.1', 'well.startVelocity.0', 'well.startVelocity.1'
  ];

  const MODIFIERS = ['straight', 'dotted', 'triplet'];
  const CURVES = ['lin', 'exp', 'log', 's'];
  const LFO_SHAPES = ['sine', 'tri', 'saw', 'ramp', 'square', 'sh', 'smooth', 'custom'];
  const PAD_PHYSICS = ['none', 'spring', 'inertia', 'bounce', 'gravity'];
  const ENV_TRIGGERS = ['gate', 'trigger', 'threshold', 'beat', 'midi', 'manual'];
  const MACRO_OPS = ['add', 'sub', 'mul', 'min', 'max', 'avg', 'xfade', 'quantize', 'slew', 'curve', 'invert', 'scale'];
  const TARGET_KINDS = ['jam', 'live', 'macro', 'cc', 'self'];
  const MOTION_OUTPUTS = ['alpha', 'beta', 'gamma', 'accX', 'accY', 'accZ', 'accMag', 'rotA', 'rotB', 'rotG', 'shake'];

  // p(kind, id, name, opts): kind 'num' (range from config group), 'choice' (items), 'division' (items from config, sent as bars)
  const N = (id, name, group, o = {}) => ({ kind: 'num', id, name, group, ...o });
  const C = (id, name, items, o = {}) => ({ kind: 'choice', id, name, items, ...o });
  const D = (id, name, o = {}) => ({ kind: 'division', id, name, ...o });
  const envG = (P) => (P && P.unit === 'ms' ? 'envMs' : 'envBeats');
  const envU = (P) => (P && P.unit === 'ms' ? 'ms' : 'beats');

  /** Source types. `code` and the order of params / outputs / refs are the core ABI. */
  const TYPES = {
    pad: { code: 1, label: 'Touch XY pad / ribbon', params: [C('layout', 'Surface', ['xy', 'ribbon-h', 'ribbon-v']), C('physics', 'Physics', PAD_PHYSICS),
      N('homeX', 'Home X', 'pad'), N('homeY', 'Home Y', 'pad'), N('springK', 'Spring', 'pad'), N('damping', 'Damping', 'pad'), N('friction', 'Friction', 'pad'), N('restitution', 'Bounciness', 'pad'), N('gravity', 'Gravity', 'pad')],
    outputs: ['x', 'y', 'pressure', 'radius', 'speed', 'fingers', 'pinch', 'rotate', 'swipeX', 'swipeY', 'swipe', 'gate'], bipolar: ['pinch', 'rotate', 'swipeX', 'swipeY'], refs: [] },
    motion: { code: 2, label: 'Device motion / tilt', params: [N('tiltRange', 'Tilt range', 'motion', { unit: '°' }), N('accelRange', 'Accel range', 'motion', { unit: 'm/s²' }), N('rotRange', 'Rotation range', 'motion', { unit: '°/s' }),
      N('deadZone', 'Dead zone', 'motion'), N('minCutoff', 'Smoothing cutoff', 'motion', { unit: 'Hz' }), N('filterBeta', 'Smoothing speed', 'motion')],
    outputs: MOTION_OUTPUTS, bipolar: ['alpha', 'beta', 'gamma', 'accX', 'accY', 'accZ', 'rotA', 'rotB', 'rotG'], refs: [] },
    lfo: { code: 3, label: 'LFO', params: [C('shape', 'Shape', LFO_SHAPES), C('sync', 'Timing', ['link', 'free']), D('division', 'Rate (bars)'), C('modifier', 'Feel', MODIFIERS),
      N('hz', 'Rate (free)', 'lfo', { scale: 'exp', unit: 'Hz' }), N('phase', 'Phase', 'lfo'), N('pulseWidth', 'Pulse width', 'lfo'), N('amount', 'Amount', 'lfo'),
      N('fadeBeats', 'Fade-in', 'lfo', { unit: 'beats' }), N('fadeMs', 'Fade-in (free)', 'lfo', { unit: 'ms' }), C('retrigger', 'Retrigger', ['none', 'bar', 'trigger']), N('seed', 'Seed', 'lfo', { integer: true, modulatable: false })],
    outputs: ['out'], bipolar: ['out'], refs: [{ id: 'trigger', name: 'Retrigger / fade source' }], data: 'points' },
    env: { code: 4, label: 'Envelope', params: [C('mode', 'Shape', ['adsr', 'ahdsr', 'multi']), C('unit', 'Time unit', ['beats', 'ms']),
      N('attack', 'Attack', envG, { unit: envU }), N('hold', 'Hold', envG, { unit: envU }), N('decay', 'Decay', envG, { unit: envU }), N('sustain', 'Sustain', envG), N('release', 'Release', envG, { unit: envU }),
      C('attackCurve', 'Attack curve', CURVES, { def: 'log' }), C('decayCurve', 'Decay curve', CURVES, { def: 'exp' }), C('trigger', 'Trigger', ENV_TRIGGERS),
      N('everyBeats', 'Every', 'env', { unit: 'beats' }), N('gateLen', 'Gate length', envG, { unit: envU }), N('threshold', 'Threshold', 'env'), N('hysteresis', 'Hysteresis', 'env'),
      N('midiNote', 'MIDI note (-1 any)', 'env', { integer: true, modulatable: false }), N('midiChannel', 'MIDI channel (0 any)', 'env', { integer: true, modulatable: false }),
      C('velocity', 'Velocity', ['off', 'on']), N('amount', 'Amount', 'env')],
    outputs: ['out'], bipolar: [], refs: [{ id: 'trigger', name: 'Trigger source' }], data: 'stages' },
    seq: { code: 5, label: 'Step sequencer', params: [N('steps', 'Steps', 'seq', { integer: true }), D('division', 'Step (bars)', { def: '1/16' }), C('modifier', 'Feel', MODIFIERS), N('glide', 'Glide', 'seq')],
      outputs: ['out', 'trig'], bipolar: [], refs: [], data: 'values' },
    euclid: { code: 6, label: 'Euclidean triggers', params: [N('steps', 'Steps', 'euclid', { integer: true }), N('pulses', 'Pulses', 'euclid', { integer: true }), N('rotate', 'Rotate', 'euclid', { integer: true }),
      D('division', 'Step (bars)', { def: '1/16' }), C('modifier', 'Feel', MODIFIERS), N('gate', 'Gate length', 'euclid')], outputs: ['gate'], bipolar: [], refs: [] },
    lorenz: { code: 7, label: 'Chaos: Lorenz attractor', params: [N('speed', 'Speed', 'lorenz')], outputs: ['x', 'y', 'z'], bipolar: ['x', 'y', 'z'], refs: [] },
    logistic: { code: 8, label: 'Chaos: logistic map', params: [N('r', 'Chaos (r)', 'logistic'), D('division', 'Step (bars)'), C('modifier', 'Feel', MODIFIERS), N('glide', 'Glide', 'logistic')], outputs: ['out'], bipolar: [], refs: [] },
    walk: { code: 9, label: 'Random walk (Brownian)', params: [N('rate', 'Steps / s', 'walk', { scale: 'exp' }), N('sigma', 'Step size', 'walk'), N('seed', 'Seed', 'walk', { integer: true, modulatable: false })], outputs: ['out'], bipolar: ['out'], refs: [] },
    perlin: { code: 10, label: 'Perlin noise', params: [C('sync', 'Timing', ['link', 'free']), N('cyclesPerBeat', 'Speed (per beat)', 'perlin', { scale: 'exp' }), N('hz', 'Speed (free)', 'perlin', { scale: 'exp', unit: 'Hz' }),
      N('octaves', 'Octaves', 'perlin', { integer: true }), N('seed', 'Seed', 'perlin', { integer: true, modulatable: false })], outputs: ['out'], bipolar: ['out'], refs: [] },
    sh: { code: 11, label: 'Sample & hold', params: [C('clock', 'Clock', ['beats', 'trigger', 'manual']), D('division', 'Every (bars)'), C('modifier', 'Feel', MODIFIERS), N('glideMs', 'Glide', 'sh', { unit: 'ms' })],
      outputs: ['out'], bipolar: ['out'], refs: [{ id: 'input', name: 'Input' }, { id: 'trigger', name: 'Trigger' }] },
    mic: { code: 12, label: 'Mic envelope follower', params: [N('gain', 'Gain', 'mic', { scale: 'exp' }), N('attackMs', 'Attack', 'mic', { unit: 'ms' }), N('releaseMs', 'Release', 'mic', { unit: 'ms' })], outputs: ['out'], bipolar: [], refs: [] },
    ball: { code: 13, label: 'Bouncing ball', params: [N('gravity', 'Gravity', 'ball'), N('restitution', 'Bounciness', 'ball'), C('trigger', 'Drop on', ['trigger', 'beat', 'manual']), N('everyBeats', 'Every', 'ball', { unit: 'beats' })],
      outputs: ['out'], bipolar: [], refs: [{ id: 'trigger', name: 'Drop trigger' }] },
    well: { code: 14, label: 'Gravity well XY', params: [N('strength', 'Pull', 'well'), N('damping', 'Damping', 'well'), N('softening', 'Softness', 'well'), N('homeX', 'Rest X', 'well'), N('homeY', 'Rest Y', 'well')],
      outputs: ['x', 'y'], bipolar: [], refs: [{ id: 'pad', name: 'Well follows pad (finger)' }] },
    midi: { code: 15, label: 'MIDI CC / notes in', params: [C('kind', 'Listen to', ['cc', 'note']), N('cc', 'CC number', 'midi', { integer: true, modulatable: false }), N('channel', 'Channel (0 any)', 'midi', { integer: true, modulatable: false })],
      outputs: ['value', 'gate', 'velocity'], bipolar: [], refs: [] },
    macro: { code: 16, label: 'Macro (math)', params: [C('op', 'Operation', MACRO_OPS), N('amount', 'Amount', 'macro'), N('offset', 'Offset', 'macro'), N('steps', 'Steps', 'macro', { integer: true }),
      N('slewMs', 'Slew', 'macro', { unit: 'ms' }), C('curve', 'Curve', ['exp', 'log', 's']), N('curveAmount', 'Curve amount', 'macro')],
    outputs: ['out'], bipolar: [], refs: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C (crossfade)' }] }
  };

  function cfgPath(cfg, path) {
    return path.split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[/^\d+$/.test(k) ? Number(k) : k]), cfg);
  }
  function parseFraction(label) {
    const m = String(label).match(/^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?\s*$/);
    if (!m) return NaN;
    return m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1]);
  }

  /** Concrete parameter definitions of a source type for the current params (ranges depend on e.g. the envelope unit). */
  function paramDefs(type, params, cfg) {
    const T = TYPES[type];
    if (!T) throw new Error(`unknown source type ${type}`);
    return T.params.map((p) => {
      if (p.kind === 'choice' || p.kind === 'division') {
        const items = p.kind === 'division' ? cfg.lfo.divisions.slice() : p.items.slice();
        const def = p.def !== undefined && items.includes(p.def) ? p.def : p.kind === 'division' ? cfg.lfo.defaultDivision : items[0];
        return { id: p.id, name: p.name, min: 0, max: items.length - 1, default: def, steps: items.length, valueItems: items, scale: 'lin', choice: true, division: p.kind === 'division', modulatable: false };
      }
      const group = typeof p.group === 'function' ? p.group(params) : p.group;
      const r = cfg.ranges[group] && cfg.ranges[group][p.id];
      if (!Array.isArray(r) || r.length < 3) throw new Error(`client.modulator.ranges.${group}.${p.id} missing in jamconnect.config.json`);
      const d = { id: p.id, name: p.name, min: r[0], max: r[1], default: r[2], scale: p.scale || 'lin', modulatable: p.modulatable !== false };
      const unit = typeof p.unit === 'function' ? p.unit(params) : p.unit;
      if (unit) d.unit = unit;
      if (p.integer) d.steps = Math.round(r[1] - r[0]) + 1;
      return d;
    });
  }
  function transformDefs(cfg) {
    const T = cfg.ranges.transform;
    return { depth: { id: 'depth', name: 'Depth', min: T.depth[0], max: T.depth[1], default: T.depth[2], scale: 'lin', modulatable: true },
      offset: { id: 'offset', name: 'Offset', min: T.offset[0], max: T.offset[1], default: T.offset[2], scale: 'lin', modulatable: true } };
  }

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  /** PARAMS-PROTOCOL unit mapping (manifest <-> normalized wire values). */
  function realToNorm(def, v) {
    if (def.choice) { const i = def.valueItems.indexOf(String(v)); return def.valueItems.length > 1 ? Math.max(0, i) / (def.valueItems.length - 1) : 0; }
    if (def.max === def.min) return 0;
    if (def.scale === 'exp' && def.min > 0) return clamp01(Math.log(v / def.min) / Math.log(def.max / def.min));
    return clamp01((v - def.min) / (def.max - def.min));
  }
  function normToReal(def, n) {
    n = clamp01(Number.isFinite(n) ? n : 0);
    if (def.choice) return def.valueItems[Math.round(n * (def.valueItems.length - 1))];
    let v = def.scale === 'exp' && def.min > 0 ? def.min * Math.pow(def.max / def.min, n) : def.min + n * (def.max - def.min);
    if (def.steps > 1) { const span = def.max - def.min; v = def.min + Math.round((v - def.min) / span * (def.steps - 1)) * span / (def.steps - 1); }
    return v;
  }
  function coerce(def, v) {
    if (def.choice) return def.valueItems.includes(String(v)) ? String(v) : def.default;
    const x = Number(v);
    if (!Number.isFinite(x)) return def.default;
    const lo = Math.min(def.min, def.max), hi = Math.max(def.min, def.max);
    const c = x < lo ? lo : x > hi ? hi : x;
    return def.steps > 1 ? normToReal(def, realToNorm(def, c)) : c;
  }
  /** Value as the core expects it: choices as item index, divisions as bars. */
  function toCore(def, v) {
    if (def.division) return parseFraction(v);
    if (def.choice) return Math.max(0, def.valueItems.indexOf(String(v)));
    return Number(v);
  }

  /** Factory examples. Targets resolve lazily: JamConnect params by name pattern, M4L by the first device found. */
  function factoryScenes() {
    const filter = 'cutoff|filter|freq';
    const S = (name, sources, routes) => ({ name, scene: { format: 'jamconnect-mod-scene', version: 1, sources, routes } });
    return [
      S('Tilt filter sweep', [{ id: 'motion', type: 'motion' }],
        [{ id: 'tilt', name: 'Tilt → filter', source: 'motion.beta', mode: 'absolute', transform: { slewMs: 40 }, targets: [{ kind: 'jam', instanceId: '*', match: filter }, { kind: 'macro', instance: '*first', macro: 0 }] }]),
      S('Shake to drop', [{ id: 'motion', type: 'motion' },
        { id: 'drop', type: 'env', name: 'Drop', params: { mode: 'ahdsr', unit: 'beats', attack: 0, hold: 1, decay: 2, sustain: 0, release: 0.5, trigger: 'trigger', gateLen: 1 }, refs: { trigger: 'motion.shake' } },
        { id: 'ball', type: 'ball', refs: { trigger: 'motion.shake' } }],
      [{ id: 'drop-r', name: 'Shake → filter drop', source: 'drop.out', mode: 'offset', transform: { depth: -0.9 }, targets: [{ kind: 'jam', instanceId: '*', match: filter }, { kind: 'macro', instance: '*first', macro: 0, base: 0.8 }] },
        { id: 'ball-r', name: 'Bounce → volume', source: 'ball.out', mode: 'absolute', targets: [{ kind: 'jam', instanceId: '*', match: 'volume|gain|amp|level' }] }]),
      S('Link-synced wobble', [{ id: 'wobble', type: 'lfo', name: 'Wobble', params: { shape: 'sine', sync: 'link', division: '1/8', modifier: 'triplet' } }],
        [{ id: 'wob', name: 'Wobble → filter', source: 'wobble.out', mode: 'offset', transform: { depth: 0.6 }, targets: [{ kind: 'jam', instanceId: '*', match: filter }, { kind: 'macro', instance: '*first', macro: 1, base: 0.5 }] }]),
      S('XY morph', [{ id: 'xy', type: 'pad', name: 'XY', params: { physics: 'inertia' } }], [
        { id: 'xy-x', name: 'X → morph', source: 'xy.x', mode: 'absolute', targets: [{ kind: 'jam', instanceId: '*', match: 'morph|position|wave|table|shape' }, { kind: 'macro', instance: '*first', macro: 2 }] },
        { id: 'xy-y', name: 'Y → filter', source: 'xy.y', mode: 'absolute', targets: [{ kind: 'jam', instanceId: '*', match: filter }, { kind: 'macro', instance: '*first', macro: 3 }] },
        { id: 'xy-p', name: 'Pressure → resonance', source: 'xy.pressure', mode: 'offset', transform: { depth: 0.5 }, targets: [{ kind: 'jam', instanceId: '*', match: 'reso|^q$' }] }]),
      S('Euclid pluck', [{ id: 'eu', type: 'euclid', params: { steps: 16, pulses: 5 } },
        { id: 'pluck', type: 'env', name: 'Pluck', params: { mode: 'adsr', unit: 'beats', attack: 0, decay: 0.25, sustain: 0, release: 0.1, trigger: 'trigger', gateLen: 0.1 }, refs: { trigger: 'eu.gate' } }],
      [{ id: 'pl', name: 'Pluck → filter', source: 'pluck.out', mode: 'offset', transform: { depth: 0.7 }, targets: [{ kind: 'jam', instanceId: '*', match: filter }] }]),
      S('Chaos drift', [{ id: 'lz', type: 'lorenz', params: { speed: 0.3 } }],
        [{ id: 'lz-r', name: 'Lorenz → morph', source: 'lz.x', mode: 'offset', transform: { depth: 0.3, slewMs: 50 }, targets: [{ kind: 'jam', instanceId: '*', match: 'morph|position|wave|table|pan' }] }])
    ];
  }

  return { CONFIG_KEYS, TYPES, MODIFIERS, CURVES, LFO_SHAPES, PAD_PHYSICS, ENV_TRIGGERS, MACRO_OPS, TARGET_KINDS, MOTION_OUTPUTS,
    cfgPath, parseFraction, paramDefs, transformDefs, realToNorm, normToReal, coerce, toCore, factoryScenes };
});
