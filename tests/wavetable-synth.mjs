// Wavetable synth tests, pure Node (no browser, no audio device, no toolchain).
//
//   node tests/wavetable-synth.mjs [--config jamconnect.config.json] [--wasm path] [--require-wasm]
//
// * contract: dsp-rs/params.json <-> dsp/params.js / engine-wasm.js, config completeness
// * param normalization (lin / exp / db / steps), factory preset validation, WAV decoding
// * PARAMS-PROTOCOL instrument (announce, SET, CURVE -> AudioParam calls, offset mode, touch, echo limit)
// * Link-beat scheduling with a real JamConnector timeline and a mocked AudioContext clock
// * the AudioWorklet processor run offline with a stub AudioWorkletGlobalScope, against the real
//   Rust/wasm engine (apps/wavetable-synth/engine/synth.wasm, built by CI) or, locally without it, a
//   mock exposing the same exports. --require-wasm (CI) fails when the wasm is missing.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(root, 'apps', 'wavetable-synth');
const args = process.argv.slice(2);
const argValue = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const config = JSON.parse(fs.readFileSync(path.resolve(argValue('--config', path.join(root, 'jamconnect.config.json'))), 'utf8'));
const wasmPath = path.resolve(argValue('--wasm', path.join(appDir, 'engine', 'synth.wasm')));
const requireWasm = args.includes('--require-wasm');

let failures = 0;
const ok = (cond, label, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
  return !!cond;
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const mod = (rel) => import(pathToFileURL(path.join(appDir, rel)).href);

const S = config.client && config.client.synth;
if (!ok(!!S, 'config: client.synth exists')) process.exit(1);

const P = await mod('dsp/params.js');
const { InstrumentParams, shapeValue } = await mod('dsp/protocol.js');
const E = await mod('dsp/engine-wasm.js');
const { LinkClock, NoteScheduler, noteNumber, audioTimeForPerfMs } = await mod('dsp/scheduler.js');
const PR = await mod('dsp/presets.js');
const { parseWav, writeWavFloat } = await mod('dsp/wav.js');
const contract = JSON.parse(fs.readFileSync(path.join(appDir, 'dsp-rs', 'params.json'), 'utf8'));

// ---------------------------------------------------------------- contract
const layout = P.paramLayout(S);
const fixedIds = layout.slice(0, contract.fixed.length).map((p) => p.id);
ok(JSON.stringify(fixedIds) === JSON.stringify(contract.fixed), 'contract: fixed parameter order matches params.json (Rust table)');
const slotIds = layout.slice(contract.fixed.length).map((p) => p.id);
const expectSlots = [];
for (let m = 1; m <= S.modSlots; m++) for (const f of contract.modSlotFields) expectSlots.push(`mod${m}.${f}`);
ok(JSON.stringify(slotIds) === JSON.stringify(expectSlots), 'contract: matrix slots follow the fixed params (FIXED + 3*slot + field)');
ok(S.modSlots <= contract.maxModSlots, `contract: modSlots ${S.modSlots} <= engine capacity ${contract.maxModSlots}`);
ok(JSON.stringify(P.MOD_SOURCES) === JSON.stringify(contract.modSources), 'contract: mod sources');
ok(JSON.stringify(P.MOD_DESTS.map((d) => d.label)) === JSON.stringify(contract.modDests), 'contract: mod destinations');
ok(JSON.stringify(E.FACTORY_TABLES) === JSON.stringify(contract.factoryTables), 'contract: factory table names');
ok(JSON.stringify(E.CONFIG_KEYS) === JSON.stringify(contract.config), 'contract: engine config keys');
ok(JSON.stringify(Object.keys(E.CONTROLLERS)) === JSON.stringify(contract.controllers), 'contract: controller codes');
ok(JSON.stringify(Object.keys(E.SCALE_CODES)) === JSON.stringify(contract.scales), 'contract: scale codes');
let cfgVals = null;
try { cfgVals = E.configValues(S); } catch (err) { ok(false, 'config: engine values complete', err.message); }
ok(cfgVals && cfgVals.length === contract.config.length && [...cfgVals].every(Number.isFinite), 'config: every engine value present and finite');
ok(S.syncDivisions.length <= contract.maxDivisions && S.syncDivisions.every((d) => d.beats > 0), 'config: sync divisions fit the engine');

const schema = P.buildSchema(S, { tables: E.FACTORY_TABLES });
const byId = new Map(schema.map((p) => [p.id, p]));
ok(byId.get('osc1.unison').max <= S.engine.maxUnison && byId.get('voice.poly').max <= S.engine.maxPolyphony, 'config: unison / polyphony ranges within engine limits');
ok(schema.every((p) => Number.isFinite(p.min) && Number.isFinite(p.max) && p.default >= p.min && p.default <= p.max), 'config: every parameter range valid');
let threw = false;
try { P.buildSchema({ ...S, params: { ...S.params, 'filter.cutoff': undefined } }); } catch (_) { threw = true; }
ok(threw, 'config: a missing parameter range is rejected (nothing built in)');

// ---------------------------------------------------------------- normalization
const lin = { min: -1, max: 1, scale: 'lin', default: 0 };
const expP = { min: 20, max: 20000, scale: 'exp', default: 1000 };
const dbP = { min: -60, max: 6, scale: 'db', default: 0 };
const stP = { min: -12, max: 12, scale: 'lin', steps: 25, default: 0 };
ok(near(P.denormalize(lin, 0.75), 0.5) && near(P.normalize(lin, 0.5), 0.75), 'normalize: lin');
ok(near(P.denormalize(expP, 0.5), Math.sqrt(20 * 20000), 1e-6) && near(P.normalize(expP, 632.4555320336759), 0.5, 1e-9), 'normalize: exp (geometric)');
ok(Math.abs(P.denormalize(dbP, 0.5)) < 0.1 && near(P.normalize(dbP, P.denormalize(dbP, 0.3)), 0.3, 1e-9), 'normalize: db (linear in amplitude, round trip)');
ok(P.denormalize(stP, 0.52) === 0 && P.normalize(stP, 3) === 15 / 24 && P.quantizeNorm(stP, 0.51) === 12 / 24, 'normalize: steps snap to the grid');
const items = byId.get('filter.type');
ok(P.normalize(items, 'LP24') === 1 / 4 && P.denormalize(items, 0.25) === 1, 'normalize: value items by label');
ok(P.normalize(expP, 1e9) === 1 && P.normalize(expP, -5) === 0 && P.normalize(lin, NaN) === 0.5, 'normalize: clamps / NaN -> default');

// ---------------------------------------------------------------- presets
const factory = JSON.parse(fs.readFileSync(path.join(appDir, 'presets', 'factory.json'), 'utf8')).presets;
const cats = S.presets.categories;
ok(factory.length >= 16, `presets: ${factory.length} factory presets (>= 16)`);
ok(cats.every((c) => factory.some((p) => p.category === c)), `presets: every category covered (${cats.join(', ')})`);
const bad = factory.map((p) => [p.name, PR.validatePreset(p, schema, cats)]).filter(([, e]) => e.length);
ok(!bad.length, 'presets: all factory presets valid against the schema', bad.map(([n, e]) => `${n}: ${e.join('; ')}`).join(' | '));
ok(new Set(factory.map((p) => p.name)).size === factory.length, 'presets: unique names');
const norms = PR.presetToNorms(factory[0], schema);
const back = PR.presetToNorms(PR.normsToPreset(norms, schema, factory[0]), schema);
ok(schema.every((p) => near(norms[p.id], back[p.id], 1e-4)), 'presets: norms -> preset -> norms round trip');
ok(PR.validatePreset({ name: 'x', category: 'bass', params: { 'filter.cutoff': 5 } }, schema, cats).length === 1, 'presets: out-of-range value detected');
ok(PR.validatePreset({ name: 'x', category: 'bass', params: { nope: 1 } }, schema, cats).length === 1, 'presets: unknown param detected');
ok(PR.validatePreset({ name: 'x', category: 'bass', params: { 'filter.type': 'LP99' } }, schema, cats).length === 1, 'presets: bad value label detected');
const init = PR.initNorms(schema);
ok(near(P.denormalize(byId.get('filter.cutoff'), init['filter.cutoff']), S.params['filter.cutoff'][2], 1e-3), 'presets: init patch = config defaults');

// ---------------------------------------------------------------- WAV
const wavSamples = new Float32Array(256 * 3).map((_, i) => Math.sin((2 * Math.PI * (i % 256)) / 256));
const wav = parseWav(writeWavFloat(wavSamples, 44100, 256));
ok(wav.samples.length === wavSamples.length && wav.clmFrameSize === 256 && near(wav.samples[64], 1, 1e-6), 'wav: float WAV decoded, Serum clm frame size read');

// ---------------------------------------------------------------- PARAMS-PROTOCOL
class MockParam {
  constructor(name) { this.name = name; this.calls = []; }
  cancelScheduledValues(t) { this.calls.push(['cancel', t]); }
  setValueAtTime(v, t) { this.calls.push(['set', v, t]); }
  linearRampToValueAtTime(v, t) { this.calls.push(['lin', v, t]); }
  exponentialRampToValueAtTime(v, t) { this.calls.push(['exp', v, t]); }
}
function protoHarness(extra = {}) {
  const env = { sent: [], now: 10, wall: 1000, stepped: [], accept: true, values: [], presets: [] };
  const base = new Map(), mods = new Map();
  const ap = (m, id) => { if (!m.has(id)) m.set(id, new MockParam(id)); return m.get(id); };
  env.base = (id) => ap(base, id);
  env.mod = (id) => ap(mods, id);
  // Link: beat 100 at audio time 10 s, 120 bpm
  env.p = new InstrumentParams({
    schema, instanceId: 'SYN01', appName: 'synth', kind: 'instrument', name: 'test synth',
    send: (m) => env.sent.push(m), nowMs: () => env.wall, audioNow: () => env.now,
    audioTimeAtBeat: (b) => 10 + (b - 100) * 0.5, beatNow: () => 100 + (env.now - 10) * 2,
    baseParam: (id) => (byId.get(id).modulatable ? env.base(id) : null), modParam: (id) => env.mod(id),
    setStepped: (id, norm, time) => env.stepped.push({ id, norm, time }),
    onValue: (id, norm, origin) => env.values.push({ id, norm, origin }),
    onPreset: (preset) => env.presets.push(preset), getPreset: () => ({ name: 'current' }),
    canAccept: () => env.accept, cfg: S.protocol, ...extra
  });
  return env;
}
{
  const env = protoHarness();
  const p = env.p;
  p.handle({ type: 'JAM_PARAMS_DISCOVER' }, 'BRIDGE');
  const ann = env.sent.find((m) => m.type === 'JAM_PARAMS_ANNOUNCE');
  ok(ann && ann.instanceId === 'SYN01' && ann.kind === 'instrument' && ann.params.length === schema.length, 'protocol: DISCOVER -> ANNOUNCE with the full manifest');
  const cut = ann.params.find((q) => q.id === 'filter.cutoff');
  ok(cut && cut.scale === 'exp' && cut.min === 20 && cut.modulatable === true && typeof cut.value === 'number', 'protocol: manifest entry has range / scale / modulatable / current value');
  ok(ann.params.find((q) => q.id === 'filter.type').valueItems.length === 5 && ann.params.find((q) => q.id === 'osc1.oct').steps === 7, 'protocol: manifest has steps and valueItems');
  env.sent.length = 0;
  p.handle({ type: 'JAM_PARAMS_DISCOVER', target: 'OTHER' }, 'BRIDGE');
  ok(!env.sent.length, 'protocol: DISCOVER for another instance ignored');

  // SET now
  p.handle({ type: 'JAM_PARAM_SET', target: 'SYN01', param: 'filter.cutoff', norm: 0.25, source: 'mod' }, 'BRIDGE');
  const c = env.base('filter.cutoff').calls;
  ok(JSON.stringify(c) === JSON.stringify([['cancel', 10], ['set', 0.25, 10]]), 'protocol: SET -> cancelScheduledValues + setValueAtTime(now)', JSON.stringify(c));
  ok(p.get('filter.cutoff') === 0.25 && env.sent.some((m) => m.type === 'JAM_PARAM_CHANGED' && m.param === 'filter.cutoff' && m.norm === 0.25), 'protocol: SET updates the model and echoes CHANGED');
  p.handle({ type: 'JAM_PARAM_SET', target: 'NOPE', param: 'filter.cutoff', norm: 0.9 }, 'BRIDGE');
  ok(p.get('filter.cutoff') === 0.25, 'protocol: SET for another instance ignored');
  p.handle({ type: 'JAM_PARAM_SET', target: '*', param: 'filter.reso', norm: 0.5 }, 'BRIDGE');
  ok(p.get('filter.reso') === 0.5, 'protocol: target "*" addresses every instance');

  // SET at a Link beat
  env.base('amp.level').calls.length = 0;
  p.handle({ type: 'JAM_PARAM_SET', target: 'SYN01', param: 'amp.level', norm: 0.9, linkBeat: 102 }, 'BRIDGE');
  ok(JSON.stringify(env.base('amp.level').calls) === JSON.stringify([['cancel', 11], ['set', 0.9, 11]]), 'protocol: SET with linkBeat -> setValueAtTime at that beat\'s audio time');
  ok(p.get('amp.level') !== 0.9, 'protocol: model not changed before the beat');
  env.now = 11.01;
  p.tick();
  ok(p.get('amp.level') === 0.9, 'protocol: model follows once the beat has passed');
  env.now = 10;

  // stepped param
  p.handle({ type: 'JAM_PARAM_SET', target: 'SYN01', param: 'filter.type', norm: 0.5, linkBeat: 101 }, 'BRIDGE');
  ok(env.stepped.some((s) => s.id === 'filter.type' && s.norm === 0.5 && s.time === 10.5), 'protocol: stepped param -> timed worklet message');
  p.handle({ type: 'JAM_PARAM_SET', target: 'SYN01', param: 'osc1.oct', norm: 0.4 }, 'BRIDGE');
  ok(near(p.get('osc1.oct'), 2 / 6) && env.stepped.some((s) => s.id === 'osc1.oct' && s.time === null), 'protocol: stepped SET quantized to its steps');
}
{
  // CURVE absolute
  const env = protoHarness();
  const p = env.p;
  p.localSet('filter.cutoff', 0.1);
  env.base('filter.cutoff').calls.length = 0;
  p.handle({ type: 'JAM_PARAM_CURVE', target: 'SYN01', param: 'filter.cutoff', mode: 'absolute', source: 'lfo',
    points: [{ linkBeat: 101, norm: 0.2, shape: 'linear' }, { linkBeat: 102, norm: 0.8, shape: 'linear' }, { linkBeat: 103, norm: 0.5, shape: 'step' }] }, 'BRIDGE');
  const exp1 = [['cancel', 10], ['set', 0.1, 10], ['lin', 0.2, 10.5], ['lin', 0.8, 11], ['set', 0.5, 11.5]];
  ok(JSON.stringify(env.base('filter.cutoff').calls) === JSON.stringify(exp1), 'protocol: CURVE linear/step -> setValueAtTime + linearRampToValueAtTime', JSON.stringify(env.base('filter.cutoff').calls));
  env.now = 10.75;
  p.tick();
  ok(near(p.get('filter.cutoff'), 0.5, 1e-9), 'protocol: model follows the curve (interpolated)');
  env.now = 12;
  p.tick();
  ok(p.get('filter.cutoff') === 0.5 && !p.curves.has('filter.cutoff'), 'protocol: curve finished at its last point');

  // streaming: next chunk overlaps the running one -> cancel from its first point only
  env.now = 10;
  p.localSet('filter.reso', 0);
  p.handle({ type: 'JAM_PARAM_CURVE', target: 'SYN01', param: 'filter.reso', mode: 'absolute', points: [{ linkBeat: 101, norm: 0.4 }, { linkBeat: 104, norm: 1 }] }, 'BRIDGE');
  env.base('filter.reso').calls.length = 0;
  p.handle({ type: 'JAM_PARAM_CURVE', target: 'SYN01', param: 'filter.reso', mode: 'absolute', points: [{ linkBeat: 103, norm: 0.2 }, { linkBeat: 105, norm: 0.3 }] }, 'BRIDGE');
  const sc = env.base('filter.reso').calls;
  ok(sc[0][0] === 'cancel' && sc[0][1] === 11.5 && sc.some((x) => x[0] === 'lin' && x[1] === 0.3 && x[2] === 12.5), 'protocol: streamed CURVE replaces the schedule from its first point', JSON.stringify(sc));

  // late arrival: jump to the interpolated current value
  env.base('filter.drive').calls.length = 0;
  p.handle({ type: 'JAM_PARAM_CURVE', target: 'SYN01', param: 'filter.drive', mode: 'absolute', points: [{ linkBeat: 99, norm: 0 }, { linkBeat: 101, norm: 1 }] }, 'BRIDGE');
  const lc = env.base('filter.drive').calls;
  ok(JSON.stringify(lc) === JSON.stringify([['cancel', 10], ['set', 0.5, 10], ['lin', 1, 10.5]]), 'protocol: past points dropped, value jumps to the interpolated current value', JSON.stringify(lc));
  env.base('filter.key').calls.length = 0;
  p.handle({ type: 'JAM_PARAM_CURVE', target: 'SYN01', param: 'filter.key', mode: 'absolute', points: [{ linkBeat: 90, norm: 0.3 }, { linkBeat: 95, norm: 0.7 }] }, 'BRIDGE');
  ok(JSON.stringify(env.base('filter.key').calls) === JSON.stringify([['cancel', 10], ['set', 0.7, 10]]) && p.get('filter.key') === 0.7, 'protocol: an entirely late curve jumps to its last value');

  // shapes
  env.base('osc1.pos').calls.length = 0;
  p.localSet('osc1.pos', 0);
  env.base('osc1.pos').calls.length = 0;
  p.handle({ type: 'JAM_PARAM_CURVE', target: 'SYN01', param: 'osc1.pos', mode: 'absolute', points: [{ linkBeat: 102, norm: 1, shape: 's' }] }, 'BRIDGE');
  const sCalls = env.base('osc1.pos').calls.filter((x) => x[0] === 'lin');
  const K = Math.min(S.protocol.curveMaxSubdivisions, Math.ceil(Math.sqrt((1 * 6) / (8 * S.protocol.curveTolerance))));
  const maxErr = sCalls.reduce((m, x, i) => {
    const prevT = i ? sCalls[i - 1][2] : 10;
    const mid = (prevT + x[2]) / 2;
    const prevV = i ? sCalls[i - 1][1] : 0;
    return Math.max(m, Math.abs((prevV + x[1]) / 2 - shapeValue('s', 0, 1, (mid - 10) / 1, S.protocol.expEpsilon)));
  }, 0);
  ok(sCalls.length === K && near(sCalls[K - 1][1], 1) && near(sCalls[K - 1][2], 11), `protocol: s-curve -> ${K} linear ramps ending on the point`);
  ok(maxErr <= S.protocol.curveTolerance * 1.01, 'protocol: s-curve subdivision within curveTolerance', `max error ${maxErr.toExponential(2)}`);
  p.localSet('osc2.pos', 0.2);
  env.base('osc2.pos').calls.length = 0;
  p.handle({ type: 'JAM_PARAM_CURVE', target: 'SYN01', param: 'osc2.pos', mode: 'absolute', points: [{ linkBeat: 101, norm: 0.8, shape: 'exp' }] }, 'BRIDGE');
  ok(env.base('osc2.pos').calls.some((x) => x[0] === 'exp' && x[1] === 0.8 && x[2] === 10.5), 'protocol: exp shape -> exponentialRampToValueAtTime');

  // offset mode: bipolar on the ".mod" lane, base untouched, not blocked by touch
  p.localTouch('filter.cutoff');
  const before = p.get('filter.cutoff');
  p.handle({ type: 'JAM_PARAM_CURVE', target: 'SYN01', param: 'filter.cutoff', mode: 'offset', source: 'lfo',
    points: [{ linkBeat: 101, norm: -0.5, shape: 'linear' }, { linkBeat: 102, norm: 0.5, shape: 'linear' }] }, 'BRIDGE');
  const oc = env.mod('filter.cutoff').calls;
  ok(JSON.stringify(oc) === JSON.stringify([['cancel', 10], ['set', 0, 10], ['lin', -0.5, 10.5], ['lin', 0.5, 11]]), 'protocol: offset CURVE scheduled on the bipolar .mod AudioParam', JSON.stringify(oc));
  ok(p.get('filter.cutoff') === before, 'protocol: offset modulation leaves the knob (base) value alone');
  env.now = 10.75;
  ok(near(p.offsetNow('filter.cutoff'), 0), 'protocol: current offset tracked for the UI ring');
  p.localRelease('filter.cutoff');
}
{
  // touch ownership + echo rate limit + permissions
  const env = protoHarness();
  const p = env.p;
  p.handle({ type: 'JAM_PARAM_TOUCH', target: 'SYN01', param: 'osc1.level', source: 'A' }, 'BRIDGE');
  p.handle({ type: 'JAM_PARAM_SET', target: 'SYN01', param: 'osc1.level', norm: 0.1, source: 'B' }, 'BRIDGE');
  ok(p.get('osc1.level') !== 0.1, 'protocol: touched param ignores other sources');
  p.handle({ type: 'JAM_PARAM_SET', target: 'SYN01', param: 'osc1.level', norm: 0.3, source: 'A' }, 'BRIDGE');
  ok(p.get('osc1.level') === 0.3, 'protocol: the owner can set it');
  p.handle({ type: 'JAM_PARAM_TOUCH', target: 'SYN01', param: 'osc1.level', source: 'B' }, 'BRIDGE');
  p.handle({ type: 'JAM_PARAM_SET', target: 'SYN01', param: 'osc1.level', norm: 0.35, source: 'B' }, 'BRIDGE');
  ok(p.get('osc1.level') === 0.35, 'protocol: latest touch wins');
  p.handle({ type: 'JAM_PARAM_RELEASE', target: 'SYN01', param: 'osc1.level', source: 'B' }, 'BRIDGE');
  p.localTouch('osc1.level');
  p.handle({ type: 'JAM_PARAM_TOUCH', target: 'SYN01', param: 'osc1.level', source: 'A' }, 'BRIDGE');
  p.handle({ type: 'JAM_PARAM_SET', target: 'SYN01', param: 'osc1.level', norm: 0.9, source: 'A' }, 'BRIDGE');
  ok(p.get('osc1.level') === 0.35, 'protocol: the local user always wins');
  p.localRelease('osc1.level');
  p.handle({ type: 'JAM_PARAM_SET', target: 'SYN01', param: 'osc1.level', norm: 0.9, source: 'A' }, 'BRIDGE');
  ok(p.get('osc1.level') === 0.9, 'protocol: remote control resumes after the local release');

  env.sent.length = 0;
  for (let i = 1; i <= 10; i++) { env.wall += 1; p.localSet('osc1.pos', i / 20); }
  const echoes = () => env.sent.filter((m) => m.type === 'JAM_PARAM_CHANGED' && m.param === 'osc1.pos');
  ok(echoes().length === 1, `protocol: CHANGED rate-limited (1 of 10 within ${S.protocol.echoIntervalMs} ms)`);
  p.tick();
  ok(echoes().length === 1, 'protocol: no trailing echo before the interval');
  env.wall += S.protocol.echoIntervalMs;
  p.tick();
  ok(echoes().length === 2 && echoes()[1].norm === 0.5, 'protocol: trailing echo carries the newest value');

  env.accept = false;
  p.handle({ type: 'JAM_PARAM_SET', target: 'SYN01', param: 'osc1.pos', norm: 0.95, source: 'guest' }, 'jam-guest');
  ok(p.get('osc1.pos') === 0.5, 'protocol: SET without host permission ignored');
  env.accept = true;

  p.handle({ type: 'JAM_PRESET_LOAD', target: 'SYN01', preset: { name: 'X', category: 'bass', params: {} } }, 'BRIDGE');
  ok(env.presets.length === 1 && env.presets[0].name === 'X', 'protocol: JAM_PRESET_LOAD hands the preset to the app');
  env.sent.length = 0;
  p.handle({ type: 'JAM_PRESET_GET', target: 'SYN01', requestId: 7 }, 'BRIDGE');
  ok(env.sent[0] && env.sent[0].type === 'JAM_PRESET_STATE' && env.sent[0].preset.name === 'current' && env.sent[0].requestId === 7, 'protocol: JAM_PRESET_GET -> JAM_PRESET_STATE');
  env.sent.length = 0;
  p.setAll(PR.initNorms(schema), 'preset', { name: 'Init', category: 'bass' });
  ok(env.sent.length === 1 && env.sent[0].type === 'JAM_PRESET_CHANGED' && Object.keys(env.sent[0].values).length === schema.length, 'protocol: preset load sends one JAM_PRESET_CHANGED, not a CHANGED burst');
  p.handle({ type: 'DEVICE_PARAMETER_CHANGE', param: 'filter.reso', value: 0.6 }, 'BRIDGE');
  ok(near(p.get('filter.reso'), 0.6), 'protocol: legacy DEVICE_PARAMETER_CHANGE accepted');
}

// ---------------------------------------------------------------- Link-beat scheduling
globalThis.window = globalThis.window || { location: new URL('http://jamconnect.test/') };
const { JamConnector } = require(path.join(root, 'JamConnect', 'jamconnect.js'));
JamConnector.configure(config);
const jc = new JamConnector('synth-test', null, { followLink: false });
const P0 = 50000; // perf ms
let perf = P0;
const tl = jc.linkTimeline;
Object.assign(tl, { source: 'bridge', tempo: 120, beat: 0, atUs: P0 * 1000, quantum: 4 });
const ctx = { currentTime: 5, getOutputTimestamp: () => ({ contextTime: 5, performanceTime: P0 }) };
const clock = new LinkClock({ connector: jc, getContext: () => ctx, perfNow: () => perf });
ok(near(audioTimeForPerfMs(ctx, P0 + 250, P0), 5.25), 'link: performance time -> audio time via getOutputTimestamp');
ok(near(clock.timeAtBeat(2), 6), 'link: Link beat -> AudioContext time (JamConnector.linkTimeAtBeat)');
ok(near(clock.beatAtAudioTime(6.5), 3), 'link: AudioContext time -> Link beat');
perf = P0 + 250;
ok(clock.nextGridBeat(1) === 1 && clock.nextGridBeat(0.25) === 0.5, 'link: quantized note-on goes to the next grid line');
const lm = clock.linkMessage();
ok(lm.tempo === 120 && near(lm.beat, 0.5) && near(lm.time, 5.25), 'link: worklet message maps a beat to an audio time');
perf = P0;
const posted = [];
let audioNow = 5;
const sched = new NoteScheduler({ clock, post: (m) => posted.push(m), audioNow: () => audioNow });
sched.noteOn(60, 0.8, 4);
ok(posted[0].type === 'note' && posted[0].on && near(posted[0].time, 7), 'link: note-on at linkBeat 4 -> audio time 7 s');
sched.noteOff(60, 1);
ok(near(posted[1].time, 7), 'link: a note-off never overtakes its note-on');
sched.noteOn(62, 0.8, -3);
ok(near(posted[2].time, 5), 'link: a past linkBeat plays now');
sched.noteOn(64, 0.8);
ok(posted[3].time === null, 'link: no linkBeat -> on arrival');
const r1 = sched.midiEvent({ kind: 'noteon', note: 67, velocity: 127, channel: 1 }, 2);
ok(r1.handled && near(posted[4].time, 6) && posted[4].velocity === 1, 'link: MIDI_EVENT with linkBeat scheduled on the Link timeline');
sched.midiEvent({ kind: 'noteon', note: 67, velocity: 0 });
ok(posted[5].on === false, 'midi: noteon velocity 0 = note-off');
const rc = sched.midiEvent({ kind: 'cc', cc: 74, value: 127 }, undefined, S.midi.ccMap);
ok(rc.param === 'filter.cutoff' && rc.norm === 1, 'midi: CC mapped to a parameter (client.synth.midi.ccMap)');
sched.midiEvent({ kind: 'cc', cc: 1, value: 64 }, undefined, S.midi.ccMap);
ok(posted[posted.length - 1].kind === 'wheel' && near(posted[posted.length - 1].value, 64 / 127), 'midi: CC1 -> mod wheel');
sched.midiEvent({ kind: 'pitchbend', value: 0 });
sched.midiEvent({ kind: 'pitchbend', value: 16383 });
ok(posted[posted.length - 2].value === 0 && near(posted[posted.length - 1].value, 1, 1e-3), 'midi: pitch bend (normalized or 14-bit)');
tl.tempo = null;
ok(clock.timeAtBeat(2) === null && clock.linkMessage().tempo === 0, 'link: no tempo -> no beat scheduling, worklet told there is no tempo (no default tempo)');
tl.tempo = 120;
ok(noteNumber('C2') === 36 && noteNumber('A4') === 69 && noteNumber('F#3') === 54 && noteNumber(40) === 40 && noteNumber('x') === null, 'pads: PAD_PLAY note names');

// ---------------------------------------------------------------- engine: real wasm or mock
const haveWasm = fs.existsSync(wasmPath);
if (requireWasm) ok(haveWasm, `engine: ${path.relative(root, wasmPath)} present (built by the synth-wasm CI job)`);
console.log(`\n# engine under test: ${haveWasm ? `real Rust/wasm (${fs.statSync(wasmPath).size} bytes)` : 'JS mock with the same exports (no synth.wasm here)'}`);

/** Mock of the wasm exports (same ABI) for running the glue tests without a build. */
function mockExports() {
  const memory = { buffer: new ArrayBuffer(1 << 22) };
  let top = 64;
  const f32 = () => new Float32Array(memory.buffer);
  const st = { norm: new Float32Array(136), info: [], voices: [], q: [], link: [0, 0], tables: 7, order: 0, view: 0, peak: [0, 0] };
  const denorm = (i) => { const inf = st.info[i]; if (!inf) return st.norm[i]; const [mn, mx, , steps] = inf; return steps > 1 ? mn + Math.round(st.norm[i] * (steps - 1)) * (mx - mn) / (steps - 1) : mn + st.norm[i] * (mx - mn); };
  const ramps = new Map();
  const tableData = new Map();
  const x = {
    memory,
    wt_alloc: (n) => { const p = top; top += ((n * 4 + 15) & ~15); return p; },
    wt_dealloc: () => {},
    synth_config_len: () => E.CONFIG_KEYS.length,
    synth_new: () => 8,
    synth_param_capacity: () => 136, synth_fixed_param_count: () => contract.fixed.length, synth_max_mod_slots: () => contract.maxModSlots,
    synth_param_info: (_p, i, mn, mx, sc, steps) => { st.info[i] = [mn, mx, sc, steps]; },
    synth_set_param: (_p, i, v) => { st.norm[i] = v; ramps.delete(i); },
    synth_get_param: (_p, i) => st.norm[i],
    synth_ramp_param: (_p, i, v, frames, shape) => ramps.set(i, { from: st.norm[i], to: v, frames, left: frames, shape }),
    synth_set_division: () => {},
    synth_set_link: (_p, beat, tempo) => { st.link = [beat, tempo]; },
    synth_note_on: (_p, note, vel, off) => st.q.push({ off, on: true, note, vel }),
    synth_note_off: (_p, note, off) => st.q.push({ off, on: false, note }),
    synth_controller: () => {},
    synth_all_notes_off: () => { st.voices = []; },
    synth_process: (_p, lp, rp, n) => {
      const L = f32().subarray(lp >>> 2, (lp >>> 2) + n), R = f32().subarray(rp >>> 2, (rp >>> 2) + n);
      L.fill(0); R.fill(0);
      st.q.sort((a, b) => a.off - b.off);
      const poly = Math.max(1, Math.round(denorm(contract.fixed.indexOf('voice.poly'))));
      for (let i = 0; i < n; i++) {
        while (st.q.length && st.q[0].off <= i) {
          const e = st.q.shift();
          if (e.on) {
            if (st.voices.length >= poly) st.voices.sort((a, b) => a.order - b.order).shift();
            st.voices.push({ note: e.note, vel: e.vel, ph: 0, order: ++st.order });
          } else st.voices = st.voices.filter((v) => v.note !== e.note);
        }
        for (const v of st.voices) { L[i] += 0.2 * v.vel * Math.sin(v.ph + 0.5); v.ph += (2 * Math.PI * 440 * 2 ** ((v.note - 69) / 12)) / 48000; }
        R[i] = L[i];
        st.peak[0] = Math.max(st.peak[0], Math.abs(L[i]));
      }
      for (const e of st.q) e.off -= n;
      for (const [i, r] of ramps) { r.left = Math.max(0, r.left - n); st.norm[i] = r.from + (r.to - r.from) * (1 - r.left / r.frames); if (!r.left) ramps.delete(i); }
    },
    synth_load_table: (_p, slot, _ptr, frames, size) => (frames > 0 && (size & (size - 1)) === 0 && slot === st.tables ? (st.tables++, slot) : -2),
    synth_table_count: () => st.tables,
    synth_table_frames: () => S.wavetable.frames,
    synth_table_levels: () => 1,
    synth_table_level_size: () => 256,
    synth_table_level_harmonics: () => 31,
    synth_table_level_ptr: (_p, slot) => { if (!tableData.has(slot)) { const p = x.wt_alloc(S.wavetable.frames * 256); f32().fill(0.5, p >>> 2, (p >>> 2) + S.wavetable.frames * 256); tableData.set(slot, p); } return tableData.get(slot); },
    synth_active_voices: () => st.voices.length,
    synth_voice_note: (_p, i) => (st.voices[i] ? st.voices[i].note : -1),
    synth_take_peak: (_p, ch) => { const v = st.peak[ch] || 0; st.peak[ch] = 0; return v; },
    synth_limiter_reduction: () => 1,
    synth_mod_view: () => { if (!st.view) st.view = x.wt_alloc(136); f32().set(st.norm, st.view >>> 2); return st.view; },
    synth_delay_time: () => { const sync = Math.round(denorm(contract.fixed.indexOf('delay.sync'))); const div = S.syncDivisions[Math.round(denorm(contract.fixed.indexOf('delay.div')))]; return sync && st.link[1] > 0 ? div.beats * 60 / st.link[1] : denorm(contract.fixed.indexOf('delay.time')); }
  };
  return x;
}

const wasmModule = haveWasm ? new WebAssembly.Module(fs.readFileSync(wasmPath)) : null;
const engineSrc = () => (wasmModule ? { module: wasmModule } : { exports: mockExports() });

{
  const ws = new E.WasmSynth(engineSrc(), 48000, S, schema, S.engine.renderQuantum);
  ok(ws.tableCount() === E.FACTORY_TABLES.length, `engine: ${ws.tableCount()} factory wavetables generated`);
  const t0 = ws.tableLevel0(0);
  ok(t0 && t0.frames === S.wavetable.frames && (t0.size & (t0.size - 1)) === 0 && t0.data.every(Number.isFinite), 'engine: table level 0 readable (frames x power-of-two size)');
  if (wasmModule) {
    const peak = t0.data.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    ok(near(peak, 1, 1e-3), 'engine: frames peak-normalised');
    // band-limiting of the richest level, checked from JS too
    const fr = t0.data.subarray(0, t0.size);
    const H = S.wavetable.baseHarmonics;
    let leak = 0;
    for (let k = H + 1; k <= t0.size / 2; k += 7) {
      let re = 0, im = 0;
      for (let i = 0; i < t0.size; i++) { const a = (2 * Math.PI * k * i) / t0.size; re += fr[i] * Math.cos(a); im -= fr[i] * Math.sin(a); }
      leak = Math.max(leak, (2 * Math.hypot(re, im)) / t0.size);
    }
    ok(leak < 1e-4, `engine: no harmonics above ${H} in mip level 0 (JS DFT check)`, `max ${leak.toExponential(2)}`);
  }
  const slot = ws.loadTable(ws.tableCount(), wavSamples, 256);
  ok(slot === E.FACTORY_TABLES.length && ws.tableCount() === E.FACTORY_TABLES.length + 1, 'engine: WAV samples -> wavetable (synth_load_table)');
}

// ---------------------------------------------------------------- the worklet processor, offline
let Registered = null;
const workletPosts = [];
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: (m) => workletPosts.push(m), onmessage: null }; } };
globalThis.registerProcessor = (name, cls) => { if (name === 'jc-wavetable-synth') Registered = cls; };
globalThis.sampleRate = 48000;
globalThis.currentFrame = 0;
{
  // AudioWorkletGlobalScope has no URL / fetch / setTimeout: hide them while the module evaluates.
  const href = `${pathToFileURL(path.join(appDir, 'worklet', 'processor.js')).href}?modSlots=${S.modSlots}`;
  const hidden = { URL: globalThis.URL, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout };
  globalThis.URL = undefined;
  globalThis.fetch = undefined;
  try { await import(href); } finally { Object.assign(globalThis, hidden); }
}
ok(!!Registered, 'worklet: processor registered as jc-wavetable-synth');
const descriptors = Registered.parameterDescriptors;
const modIds = P.modulatableIds(S);
ok(descriptors.length === modIds.length * 2 && descriptors.some((d) => d.name === 'filter.cutoff.mod' && d.minValue === -1), 'worklet: base + bipolar .mod AudioParam for every modulatable param');

function makeProc() {
  workletPosts.length = 0;
  globalThis.currentFrame = 0;
  const src = engineSrc();
  const proc = new Registered({ processorOptions: { config: S, schema, ...(src.module ? { wasmModule: src.module } : { wasmExports: src.exports }) } });
  const parameters = {};
  for (const d of descriptors) {
    const id = d.name.endsWith('.mod') ? null : d.name;
    parameters[d.name] = new Float32Array([id ? PR.initNorms(schema)[id] : 0]);
  }
  const msg = (m) => proc.port.onmessage({ data: m });
  // stepped (non-AudioParam) params at their init values, as the page does with syncAll()
  const initN = PR.initNorms(schema);
  for (const p of schema) if (!p.modulatable) msg({ type: 'stepped', id: p.id, norm: initN[p.id] });
  const render = (blocks) => {
    const L = [], R = [];
    for (let b = 0; b < blocks; b++) {
      const outs = [[new Float32Array(S.engine.renderQuantum), new Float32Array(S.engine.renderQuantum)]];
      proc.process([], outs, parameters);
      globalThis.currentFrame += S.engine.renderQuantum;
      L.push(...outs[0][0]);
      R.push(...outs[0][1]);
    }
    return { L, R };
  };
  const stepped = (id, value) => msg({ type: 'stepped', id, norm: P.normalize(byId.get(id), value) });
  return { proc, parameters, msg, render, stepped };
}

{
  const { proc, msg, render, stepped } = makeProc();
  ok(workletPosts.some((m) => m.type === 'ready') && !workletPosts.some((m) => m.type === 'error'), 'worklet: engine instantiated in the processor', JSON.stringify(workletPosts.find((m) => m.type === 'error') || ''));
  render(1);
  stepped('master.limit', 'Off'); // no lookahead delay for the onset check
  render(1);
  const f = globalThis.currentFrame;
  msg({ type: 'note', on: true, note: 69, velocity: 1, time: (f + 64) / sampleRate });
  const { L } = render(1);
  ok(L.slice(0, 64).every((v) => v === 0) && L.slice(64).some((v) => v !== 0), 'worklet: note-on lands on its sample offset inside the quantum');
  msg({ type: 'note', on: true, note: 72, velocity: 0.8, time: null });
  msg({ type: 'note', on: true, note: 76, velocity: 0.8, time: null });
  const out = render(200);
  const all = [...out.L, ...out.R];
  ok(all.every(Number.isFinite), 'worklet: output finite (no NaN / Inf)');
  const peak = all.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  ok(peak > 0.01, 'worklet: output not silent', `peak ${peak.toFixed(3)}`);
  ok(workletPosts.some((m) => m.type === 'meter' && m.values.length === modIds.length && m.voices >= 1), 'worklet: meter messages with effective (modulated) values');
  msg({ type: 'note', on: false, note: 69, time: null });
  msg({ type: 'note', on: false, note: 72, time: null });
  msg({ type: 'note', on: false, note: 76, time: null });
  render(400);
  ok(proc.synth.activeVoices() === 0, 'worklet: voices freed after release');
}
{
  // a timed note-off that is already due must not overtake a later "now" note-on of the same key
  const { proc, render, msg } = makeProc();
  msg({ type: 'note', on: true, note: 60, velocity: 1, time: null });
  render(4);
  msg({ type: 'note', on: false, note: 60, time: globalThis.currentFrame / sampleRate });
  msg({ type: 'note', on: true, note: 60, velocity: 1, time: null });
  render(400); // > release time: only a held note is still sounding
  ok(proc.synth.activeVoices() === 1 && proc.synth.voiceNote(0) === 60, 'worklet: re-pressed key keeps arrival order (off then on)');
}
{
  const { proc, render, stepped, msg } = makeProc();
  stepped('voice.poly', 4);
  for (let n = 60; n < 66; n++) msg({ type: 'note', on: true, note: n, velocity: 0.8, time: null });
  render(20);
  const notes = [];
  for (let i = 0; i < S.engine.maxPolyphony; i++) { const n = proc.synth.voiceNote(i); if (n >= 0) notes.push(n); }
  ok(notes.length <= 4 && notes.includes(64) && notes.includes(65) && !notes.includes(60), 'worklet: voice stealing keeps the newest notes within voice.poly', JSON.stringify(notes));
}
{
  const { proc, parameters, render } = makeProc();
  const idx = schema.findIndex((p) => p.id === 'filter.cutoff');
  const n = S.engine.renderQuantum;
  parameters['filter.cutoff'] = new Float32Array(n).map((_, i) => 0.2 + (0.6 * i) / (n - 1));
  render(1);
  ok(near(proc.synth.get(idx), 0.8, 1e-4), 'worklet: automated AudioParam -> synth_ramp_param reaches the quantum\'s end value', String(proc.synth.get(idx)));
  parameters['filter.cutoff'] = new Float32Array([0.5]);
  parameters['filter.cutoff.mod'] = new Float32Array([0.25]);
  render(1);
  ok(near(proc.synth.get(idx), 0.75, 1e-6), 'worklet: effective value = base + offset lane');
  parameters['filter.cutoff.mod'] = new Float32Array([0.9]);
  render(1);
  ok(near(proc.synth.get(idx), 1, 1e-6), 'worklet: effective value clamped to 0..1');
}
{
  // Link-beat -> sample offset, end to end: JamConnector timeline -> audio time -> frame in the quantum
  const { proc, render, stepped, msg } = makeProc();
  stepped('master.limit', 'Off');
  stepped('delay.sync', 'On');
  stepped('delay.div', '1/8D');
  render(10);
  const f0 = globalThis.currentFrame;
  const ctx2 = { currentTime: f0 / sampleRate, getOutputTimestamp: () => ({ contextTime: f0 / sampleRate, performanceTime: P0 }) };
  Object.assign(tl, { source: 'bridge', tempo: 120, beat: 8, atUs: P0 * 1000 });
  const clock2 = new LinkClock({ connector: jc, getContext: () => ctx2, perfNow: () => P0 });
  msg(clock2.linkMessage());
  const sch = new NoteScheduler({ clock: clock2, post: msg, audioNow: () => ctx2.currentTime });
  const beat = 8 + 0.1; // 50 ms after beat 8 = 2400 frames
  sch.noteOn(57, 1, beat);
  const target = f0 + Math.round(0.05 * sampleRate);
  const { L } = render(30);
  const first = L.findIndex((v) => v !== 0);
  ok(first === target - f0, `worklet: note at linkBeat ${beat} starts exactly at frame ${target}`, `first sound at ${f0 + first}`);
  ok(near(proc.synth.delayTime(), 0.75 * 60 / 120, 1e-5), 'worklet: delay follows the Link tempo (1/8D at 120 bpm = 0.375 s)');
}
{
  const { render, msg } = makeProc();
  msg({ type: 'table', slot: E.FACTORY_TABLES.length, samples: wavSamples, frameSize: 256, requestId: 1 });
  render(1);
  ok(workletPosts.some((m) => m.type === 'tableLoaded' && m.slot === E.FACTORY_TABLES.length), 'worklet: imported wavetable loaded into the engine');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
